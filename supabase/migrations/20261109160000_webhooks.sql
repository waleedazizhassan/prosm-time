-- 2026-11-09 integration API v1b (spec 17.5): webhooks through an outbox.
--   * The owner registers an HTTPS address and the events it wants; a signing secret is shown once.
--   * Events (employee.created / employee.updated / employee.deactivated, attendance.clock_in /
--     attendance.clock_out, leave.requested / leave.approved / leave.rejected / leave.cancelled) are
--     written to an outbox in the same transaction as the change - nothing is lost if delivery is
--     slow - and fanned out to the matching active endpoints as deliveries.
--   * The dispatcher (Edge Function webhook-dispatch, every minute) posts each due delivery with
--     X-PROSM-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>"), retries with growing waits
--     (1, 5, 30 minutes, 2, 6, 12, 24 hours), then marks it dead; a dead delivery can be sent again.
--     An endpoint whose last 20 deliveries all died is disabled, with the reason.
--   * Payloads carry ids and states only - no amounts, no personal contact data, no payroll.
--   * Only organisations whose plan includes the API produce events (no outbox growth otherwise).

begin;

create table if not exists public.webhook_endpoints (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    url text not null check (url ~ '^https://[^\s/$.?#].[^\s]*$' and length(url) <= 500),
    description text check (description is null or length(description) <= 120),
    events text[] not null check (cardinality(events) > 0),
    secret text not null,
    secret_prefix text not null,
    environment text not null default 'live' check (environment in ('live', 'test')),
    is_active boolean not null default true,
    disabled_reason text,
    consecutive_failures integer not null default 0,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists webhook_endpoints_org_idx on public.webhook_endpoints (organization_id) where is_active;

create table if not exists public.webhook_outbox (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    event_type text not null,
    payload jsonb not null,
    created_at timestamptz not null default now()
);
create index if not exists webhook_outbox_org_idx on public.webhook_outbox (organization_id, created_at desc);

create table if not exists public.webhook_deliveries (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
    outbox_id uuid not null references public.webhook_outbox(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'dead')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_status integer,
    last_error text,
    delivered_at timestamptz,
    created_at timestamptz not null default now(),
    unique (endpoint_id, outbox_id)
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status = 'pending';
create index if not exists webhook_deliveries_endpoint_idx on public.webhook_deliveries (endpoint_id, created_at desc);

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_outbox enable row level security;
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_endpoints, public.webhook_outbox, public.webhook_deliveries from anon, authenticated;

create or replace function public.prosm_time_webhook_events()
returns text[]
language sql
immutable
set search_path = public
as $$
    select array['employee.created', 'employee.updated', 'employee.deactivated', 'attendance.clock_in', 'attendance.clock_out',
                 'leave.requested', 'leave.approved', 'leave.rejected', 'leave.cancelled'];
$$;
revoke all on function public.prosm_time_webhook_events() from public, anon;
grant execute on function public.prosm_time_webhook_events() to authenticated, service_role;

-- Write an event and fan it out to the matching endpoints (inside the change's own transaction).
create or replace function public.prosm_time_emit_webhook(p_org uuid, p_type text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if p_org is null or not exists (select 1 from webhook_endpoints where organization_id = p_org and is_active and p_type = any(events)) then return; end if;
    if not public.prosm_time_api_enabled(p_org) then return; end if;
    insert into webhook_outbox (organization_id, event_type, payload) values (p_org, p_type, p_payload) returning id into v_id;
    insert into webhook_deliveries (organization_id, endpoint_id, outbox_id)
    select p_org, e.id, v_id from webhook_endpoints e where e.organization_id = p_org and e.is_active and p_type = any(e.events);
end;
$$;
revoke all on function public.prosm_time_emit_webhook(uuid, text, jsonb) from public, anon, authenticated;

-- The sources ------------------------------------------------------------------------------
create or replace function public.prosm_time_webhook_users()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.is_owner then return new; end if;
    if tg_op = 'INSERT' then
        perform public.prosm_time_emit_webhook(new.organization_id, 'employee.created', jsonb_build_object('employeeId', new.id, 'active', new.is_active));
    elsif old.is_active and not new.is_active then
        perform public.prosm_time_emit_webhook(new.organization_id, 'employee.deactivated', jsonb_build_object('employeeId', new.id));
    elsif (old.full_name, old.role_id, old.is_active) is distinct from (new.full_name, new.role_id, new.is_active) then
        perform public.prosm_time_emit_webhook(new.organization_id, 'employee.updated', jsonb_build_object('employeeId', new.id, 'active', new.is_active));
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_webhook_users() from public, anon, authenticated;
drop trigger if exists users_webhooks on public.users;
create trigger users_webhooks after insert or update on public.users for each row execute function public.prosm_time_webhook_users();

create or replace function public.prosm_time_webhook_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        perform public.prosm_time_emit_webhook(new.organization_id, 'attendance.clock_in',
            jsonb_build_object('attendanceId', new.id, 'employeeId', new.user_id, 'siteId', new.site_id, 'clockInAt', new.clock_in_at));
        if new.status = 'clocked_out' then
            perform public.prosm_time_emit_webhook(new.organization_id, 'attendance.clock_out',
                jsonb_build_object('attendanceId', new.id, 'employeeId', new.user_id, 'siteId', new.site_id, 'clockInAt', new.clock_in_at, 'clockOutAt', new.clock_out_at));
        end if;
    elsif old.status = 'clocked_in' and new.status = 'clocked_out' then
        perform public.prosm_time_emit_webhook(new.organization_id, 'attendance.clock_out',
            jsonb_build_object('attendanceId', new.id, 'employeeId', new.user_id, 'siteId', new.site_id, 'clockInAt', new.clock_in_at, 'clockOutAt', new.clock_out_at));
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_webhook_attendance() from public, anon, authenticated;
drop trigger if exists attendance_sessions_webhooks on public.attendance_sessions;
create trigger attendance_sessions_webhooks after insert or update of status on public.attendance_sessions for each row execute function public.prosm_time_webhook_attendance();

create or replace function public.prosm_time_webhook_leave()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_type text;
begin
    if tg_op = 'INSERT' then
        v_type := case new.status when 'pending' then 'leave.requested' when 'approved' then 'leave.approved' end;
    elsif old.status is distinct from new.status then
        v_type := case new.status when 'approved' then 'leave.approved' when 'rejected' then 'leave.rejected' when 'cancelled' then 'leave.cancelled' end;
    end if;
    if v_type is not null then
        perform public.prosm_time_emit_webhook(new.organization_id, v_type,
            jsonb_build_object('leaveId', new.id, 'employeeId', new.user_id, 'type', new.leave_type, 'startDate', new.start_date, 'endDate', new.end_date,
                               'workingDays', new.days_count, 'status', new.status));
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_webhook_leave() from public, anon, authenticated;
drop trigger if exists leave_requests_webhooks on public.leave_requests;
create trigger leave_requests_webhooks after insert or update of status on public.leave_requests for each row execute function public.prosm_time_webhook_leave();

-- Management (the owner) -------------------------------------------------------------------
create or replace function public.create_prosm_time_webhook(p_url text, p_events text[], p_description text default null, p_environment text default 'live')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_secret text := 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_id uuid;
begin
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY ADD A WEBHOOK'; end if;
    if not public.prosm_time_api_enabled(v_org) then raise exception 'FEATURE NOT IN PLAN: integrations'; end if;
    if p_url is null or p_url !~ '^https://[^\s/$.?#].[^\s]*$' or length(p_url) > 500 then raise exception 'THE ADDRESS MUST START WITH https://'; end if;
    if coalesce(cardinality(p_events), 0) = 0 or exists (select 1 from unnest(p_events) e where not (e = any(public.prosm_time_webhook_events()))) then
        raise exception 'CHOOSE VALID EVENTS';
    end if;
    if p_environment not in ('live', 'test') then raise exception 'INVALID ENVIRONMENT'; end if;
    if (select count(*) from webhook_endpoints where organization_id = v_org) >= 20 then raise exception 'AT MOST 20 WEBHOOKS'; end if;
    insert into webhook_endpoints (organization_id, url, description, events, secret, secret_prefix, environment, created_by)
    values (v_org, p_url, nullif(trim(coalesce(p_description, '')), ''), array(select distinct unnest(p_events)), v_secret, left(v_secret, 12), p_environment,
            public.current_prosm_time_user_id())
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, public.current_prosm_time_user_id(), 'WEBHOOK_CREATED', 'webhook_endpoints', v_id, 'Added a webhook.',
            jsonb_build_object('url', p_url, 'events', to_jsonb(p_events)));
    return jsonb_build_object('success', true, 'id', v_id, 'secret', v_secret);
end;
$$;

create or replace function public.list_prosm_time_webhooks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES WEBHOOKS'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'url', e.url, 'description', e.description, 'events', to_jsonb(e.events), 'secretPrefix', e.secret_prefix, 'environment', e.environment,
        'active', e.is_active, 'disabledReason', e.disabled_reason, 'createdAt', e.created_at,
        'delivered7d', (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'delivered' and d.created_at > now() - interval '7 days'),
        'dead7d', (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'dead' and d.created_at > now() - interval '7 days'),
        'pending', (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status in ('pending', 'sending')))
        order by e.created_at desc)
        from webhook_endpoints e where e.organization_id = public.current_prosm_time_organization_id()), '[]'::jsonb);
end;
$$;

create or replace function public.set_prosm_time_webhook_active(p_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES WEBHOOKS'; end if;
    update webhook_endpoints set is_active = p_active, disabled_reason = case when p_active then null else 'turned_off' end,
        consecutive_failures = case when p_active then 0 else consecutive_failures end, updated_at = now()
    where id = p_id and organization_id = v_org;
    if not found then raise exception 'WEBHOOK NOT FOUND'; end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, public.current_prosm_time_user_id(), case when p_active then 'WEBHOOK_ENABLED' else 'WEBHOOK_DISABLED' end, 'webhook_endpoints', p_id,
            case when p_active then 'Turned a webhook on.' else 'Turned a webhook off.' end);
    return jsonb_build_object('success', true);
end;
$$;

create or replace function public.delete_prosm_time_webhook(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES WEBHOOKS'; end if;
    delete from webhook_endpoints where id = p_id and organization_id = v_org;
    if not found then raise exception 'WEBHOOK NOT FOUND'; end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, public.current_prosm_time_user_id(), 'WEBHOOK_DELETED', 'webhook_endpoints', p_id, 'Deleted a webhook.');
    return jsonb_build_object('success', true);
end;
$$;

create or replace function public.list_prosm_time_webhook_deliveries(p_endpoint_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES WEBHOOKS'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'event', o.event_type, 'status', d.status, 'attempts', d.attempts, 'lastStatus', d.last_status,
                                                         'lastError', d.last_error, 'createdAt', d.created_at, 'deliveredAt', d.delivered_at, 'nextAttemptAt', d.next_attempt_at)
                                      order by d.created_at desc)
                     from (select * from webhook_deliveries where endpoint_id = p_endpoint_id and organization_id = public.current_prosm_time_organization_id()
                           order by created_at desc limit 50) d
                     join webhook_outbox o on o.id = d.outbox_id), '[]'::jsonb);
end;
$$;

-- Send a dead delivery again (recovery)
create or replace function public.redeliver_prosm_time_webhook(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES WEBHOOKS'; end if;
    update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
    where id = p_delivery_id and organization_id = public.current_prosm_time_organization_id() and status = 'dead';
    if not found then raise exception 'ONLY A FAILED DELIVERY IS SENT AGAIN'; end if;
    return jsonb_build_object('success', true);
end;
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array['public.create_prosm_time_webhook(text, text[], text, text)', 'public.list_prosm_time_webhooks()',
        'public.set_prosm_time_webhook_active(uuid, boolean)', 'public.delete_prosm_time_webhook(uuid)',
        'public.list_prosm_time_webhook_deliveries(uuid)', 'public.redeliver_prosm_time_webhook(uuid)'] loop
        execute format('revoke all on function %s from public, anon', v_fn);
        execute format('grant execute on function %s to authenticated', v_fn);
    end loop;
end $$;

-- The dispatcher (service role) ------------------------------------------------------------
create or replace function public.prosm_time_webhook_claim(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rows jsonb;
begin
    -- a delivery stuck in 'sending' for 10 minutes goes back to the queue
    update webhook_deliveries set status = 'pending' where status = 'sending' and next_attempt_at < now() - interval '10 minutes';
    with due as (
        select d.id from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
        where d.status = 'pending' and d.next_attempt_at <= now() and e.is_active
        order by d.next_attempt_at limit least(greatest(coalesce(p_limit, 50), 1), 200)
        for update of d skip locked
    ), claimed as (
        update webhook_deliveries d set status = 'sending', attempts = d.attempts + 1, next_attempt_at = now()
        from due where d.id = due.id returning d.*
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'attempts', c.attempts, 'url', e.url, 'secret', e.secret,
                                                 'body', jsonb_build_object('id', o.id, 'type', o.event_type, 'createdAt', o.created_at,
                                                                            'organizationId', o.organization_id, 'environment', e.environment, 'data', o.payload))), '[]'::jsonb)
    into v_rows
    from claimed c join webhook_endpoints e on e.id = c.endpoint_id join webhook_outbox o on o.id = c.outbox_id;
    return v_rows;
end;
$$;

create or replace function public.prosm_time_webhook_result(p_delivery_id uuid, p_status integer, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_d webhook_deliveries%rowtype;
    v_waits interval[] := array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '6 hours', interval '12 hours', interval '24 hours'];
begin
    select * into v_d from webhook_deliveries where id = p_delivery_id for update;
    if v_d.id is null then return; end if;
    if p_status between 200 and 299 then
        update webhook_deliveries set status = 'delivered', delivered_at = now(), last_status = p_status, last_error = null where id = v_d.id;
        update webhook_endpoints set consecutive_failures = 0 where id = v_d.endpoint_id;
    elsif v_d.attempts >= 8 then
        update webhook_deliveries set status = 'dead', last_status = p_status, last_error = left(p_error, 300) where id = v_d.id;
        update webhook_endpoints set consecutive_failures = consecutive_failures + 1,
            is_active = case when consecutive_failures + 1 >= 20 then false else is_active end,
            disabled_reason = case when consecutive_failures + 1 >= 20 then 'too_many_failures' else disabled_reason end
        where id = v_d.endpoint_id;
    else
        update webhook_deliveries set status = 'pending', last_status = p_status, last_error = left(p_error, 300),
            next_attempt_at = now() + v_waits[least(v_d.attempts, array_length(v_waits, 1))]
        where id = v_d.id;
    end if;
end;
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array['public.prosm_time_webhook_claim(integer)', 'public.prosm_time_webhook_result(uuid, integer, text)'] loop
        execute format('revoke all on function %s from public, anon, authenticated', v_fn);
        execute format('grant execute on function %s to service_role', v_fn);
    end loop;
end $$;

-- every minute, skipped while the vault key is missing
do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'prosm-time-webhook-dispatch';
exception
    when undefined_table then null;
end $$;
select cron.schedule('prosm-time-webhook-dispatch', '* * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/webhook-dispatch',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
        ),
        body := '{}'::jsonb
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key')
      and exists (select 1 from public.webhook_deliveries where status = 'pending' and next_attempt_at <= now());
$cron$);

commit;
