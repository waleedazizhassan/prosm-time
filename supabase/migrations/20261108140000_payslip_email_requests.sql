-- Owner 2026-11-08: an employee asks for their payslip from "My payslips"; the managers allowed to
-- issue payslips for that person are told; one of them sends it by email in one click.
--   * Only a published payslip of a locked cycle that includes the employee can be requested.
--   * The email carries the approved, stored version (same cycle, same version) - nothing is
--     recalculated at sending time; the PDF is built on the server from the stored snapshot.
--   * A manager sends only to people in their payroll scope, never their own request.
--   * Statuses: pending, sent, failed (retry allowed). "sending" is internal: it reserves the
--     request so two clicks never send twice; a reservation older than 10 minutes can be retried.
--   * Every attempt is in the action log: requester, sender, when, recipient email, cycle,
--     version, export serial, result and error.
-- The send itself is the send-payslip-email Edge Function (claim -> PDF -> email -> complete).

begin;

create table if not exists public.payslip_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
    note text check (note is null or length(note) <= 300),
    cycle_version integer,
    recipient_email text,
    export_serial bigint,
    attempts integer not null default 0,
    attempt_id uuid,
    sending_started_at timestamptz,
    handled_by uuid references public.users(id) on delete set null,
    sent_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- one open request per person and cycle
create unique index if not exists payslip_requests_one_open on public.payslip_requests (user_id, cycle_id) where status in ('pending', 'sending', 'failed');
create index if not exists payslip_requests_org_status_idx on public.payslip_requests (organization_id, status);
create index if not exists payslip_requests_cycle_idx on public.payslip_requests (cycle_id);

alter table public.payslip_requests enable row level security;
revoke all on public.payslip_requests from anon, authenticated;

-- may this person (not the caller) issue payslips for someone at this site? (same rule as prosm_time_payroll_allows)
create or replace function public.prosm_time_payroll_user_allows(p_user uuid, p_key text, p_site uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from users u where u.id = p_user and u.is_active)
       and (
           exists (select 1 from users where id = p_user and is_owner)
           or public.prosm_time_is_owner_delegate(p_user)
           or p_key = any(public.prosm_time_delegated_permissions(p_user))
           or (
               public.prosm_time_user_has_permission_internal(p_user, p_key)
               and (
                   not exists (select 1 from site_assignments sa where sa.user_id = p_user and sa.role_at_site = 'manager')
                   or exists (select 1 from site_assignments sa where sa.user_id = p_user and sa.role_at_site = 'manager' and sa.site_id = p_site)
               )
           )
       );
$$;
revoke all on function public.prosm_time_payroll_user_allows(uuid, text, uuid) from public, anon, authenticated;

-- the notification types
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('payslip_requested' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''payslip_requested''::text, ''payslip_sent''::text, ''payslip_send_failed''::text');
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- What "My payslips" shows: the locked, published cycles that include me, whether I may view
-- them in the app (the organisation's self-service switch), and my request for each.
create or replace function public.list_my_prosm_time_payslip_cycles()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_view boolean;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select coalesce(employee_self_service, false) into v_view from payroll_settings where organization_id = v_org;
    return jsonb_build_object(
        'canViewInApp', coalesce(v_view, false),
        'email', (select email from users where id = v_me),
        'cycles', coalesce((
            select jsonb_agg(jsonb_build_object(
                'cycleId', c.id, 'title', c.title, 'periodStart', c.period_start, 'periodEnd', c.period_end,
                'cycleVersion', c.published_version, 'publishedAt', c.published_at,
                'request', (select jsonb_build_object('id', r.id, 'status', case when r.status = 'sending' then 'pending' else r.status end,
                                                      'createdAt', r.created_at, 'sentAt', r.sent_at, 'cycleVersion', r.cycle_version)
                            from payslip_requests r where r.user_id = v_me and r.cycle_id = c.id order by r.created_at desc limit 1)
            ) order by c.period_start desc)
            from payroll_cycles c
            where c.organization_id = v_org and c.status = 'locked' and c.published_version is not null
              and exists (select 1 from payroll_cycle_employees ce where ce.cycle_id = c.id and ce.user_id = v_me)
        ), '[]'::jsonb));
end;
$$;
revoke all on function public.list_my_prosm_time_payslip_cycles() from public, anon;
grant execute on function public.list_my_prosm_time_payslip_cycles() to authenticated;

create or replace function public.request_prosm_time_payslip(p_cycle_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_cycle payroll_cycles%rowtype;
    v_ce payroll_cycle_employees%rowtype;
    v_id uuid;
    v_name text;
    v_recipient record;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = v_org;
    if v_cycle.id is null or v_cycle.status <> 'locked' or v_cycle.published_version is null then
        raise exception 'THIS PAYSLIP IS NOT PUBLISHED';
    end if;
    select * into v_ce from payroll_cycle_employees where cycle_id = p_cycle_id and user_id = v_me;
    if v_ce.id is null then raise exception 'THIS PAYSLIP IS NOT PUBLISHED'; end if;
    if exists (select 1 from payslip_requests where user_id = v_me and cycle_id = p_cycle_id and status in ('pending', 'sending', 'failed')) then
        raise exception 'YOU ALREADY ASKED FOR THIS PAYSLIP';
    end if;
    insert into payslip_requests (organization_id, user_id, cycle_id, note)
    values (v_org, v_me, p_cycle_id, nullif(trim(coalesce(p_note, '')), ''))
    returning id into v_id;
    select full_name into v_name from users where id = v_me;

    -- the people allowed to issue this person's payslip (no amounts in the message)
    for v_recipient in
        select u.id from users u
        where u.organization_id = v_org and u.is_active and u.id <> v_me
          and public.prosm_time_payroll_user_allows(u.id, 'payroll.export_payslips', v_ce.site_id)
    loop
        perform public.create_prosm_time_notification(v_org, v_recipient.id, 'payslip_requested', 'normal',
            'Payslip requested', v_name || ' asked for their payslip of ' || v_cycle.title || '.',
            'payslip_requests', v_id, jsonb_build_object('employeeName', v_name, 'cycleTitle', v_cycle.title));
    end loop;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (v_org, v_me, v_me, 'payroll.payslip_requested', 'payslip_requests', v_id, 'Payslip requested by email',
            jsonb_build_object('cycleId', p_cycle_id, 'cycleVersion', v_cycle.published_version));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.request_prosm_time_payslip(uuid, text) from public, anon;
grant execute on function public.request_prosm_time_payslip(uuid, text) to authenticated;

-- The requests a manager may handle (their payroll scope).
create or replace function public.list_prosm_time_payslip_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    perform public.prosm_time_require_feature('payroll');
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', r.id, 'userId', r.user_id, 'fullName', u.full_name, 'email', u.email,
            'cycleId', r.cycle_id, 'cycleTitle', c.title, 'periodStart', c.period_start, 'periodEnd', c.period_end,
            'status', case when r.status = 'sending' and r.sending_started_at < now() - interval '10 minutes' then 'failed'
                           when r.status = 'sending' then 'pending' else r.status end,
            'sending', r.status = 'sending' and r.sending_started_at >= now() - interval '10 minutes',
            'note', r.note, 'attempts', r.attempts, 'lastError', r.last_error, 'createdAt', r.created_at,
            'sentAt', r.sent_at, 'recipientEmail', r.recipient_email, 'cycleVersion', r.cycle_version, 'exportSerial', r.export_serial,
            'handledBy', (select full_name from users where id = r.handled_by),
            'cyclePublished', c.status = 'locked' and c.published_version is not null
        ) order by case r.status when 'pending' then 0 when 'sending' then 0 when 'failed' then 1 else 2 end, r.created_at desc)
        from payslip_requests r
        join users u on u.id = r.user_id
        join payroll_cycles c on c.id = r.cycle_id
        join payroll_cycle_employees ce on ce.cycle_id = r.cycle_id and ce.user_id = r.user_id
        where r.organization_id = public.current_prosm_time_organization_id()
          and r.user_id <> public.current_prosm_time_user_id()
          and public.prosm_time_payroll_allows('payroll.export_payslips', ce.site_id)
          and (p_status is null or r.status = p_status or (p_status = 'pending' and r.status = 'sending'))
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_payslip_requests(text) from public, anon;
grant execute on function public.list_prosm_time_payslip_requests(text) to authenticated;

-- Step 1 of sending (called by the Edge Function with the manager's own session): checks the
-- manager, the scope and the payslip, reserves the request against a second click, allocates
-- the export serial, and returns exactly the stored payslip of the published version.
create or replace function public.claim_prosm_time_payslip_email(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request payslip_requests%rowtype;
    v_cycle payroll_cycles%rowtype;
    v_site uuid;
    v_emp jsonb;
    v_email text;
    v_attempt uuid := gen_random_uuid();
    v_serial bigint;
    v_settings payroll_settings%rowtype;
    v_user users%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('payroll');
    select * into v_request from payslip_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    select site_id into v_site from payroll_cycle_employees where cycle_id = v_request.cycle_id and user_id = v_request.user_id;
    if not public.prosm_time_payroll_allows('payroll.export_payslips', v_site) then raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips'; end if;
    if v_request.user_id = v_me then raise exception 'YOU CANNOT DECIDE YOUR OWN REQUEST'; end if;
    if v_request.status = 'sent' then raise exception 'THIS PAYSLIP WAS ALREADY SENT'; end if;
    if v_request.status = 'sending' and v_request.sending_started_at > now() - interval '10 minutes' then
        raise exception 'THIS PAYSLIP IS BEING SENT';
    end if;
    select * into v_cycle from payroll_cycles where id = v_request.cycle_id;
    if v_cycle.status <> 'locked' or v_cycle.published_version is null then raise exception 'THIS PAYSLIP IS NOT PUBLISHED'; end if;
    select e into v_emp from payroll_cycle_snapshots s, jsonb_array_elements(s.data -> 'employees') e
    where s.cycle_id = v_cycle.id and s.cycle_version = v_cycle.published_version and (e ->> 'user_id')::uuid = v_request.user_id;
    if v_emp is null then raise exception 'THIS PAYSLIP IS NOT PUBLISHED'; end if;
    select * into v_user from users where id = v_request.user_id;
    v_email := nullif(trim(coalesce(v_user.email, '')), '');
    if v_email is null or v_email like '%@deleted.invalid' then raise exception 'THE EMPLOYEE HAS NO EMAIL'; end if;

    select * into v_settings from payroll_settings where organization_id = v_cycle.organization_id for update;
    update payroll_settings set last_export_serial = last_export_serial + 1 where organization_id = v_cycle.organization_id
    returning last_export_serial into v_serial;
    insert into payroll_exports (organization_id, serial_no, cycle_id, cycle_version, report_type, file_format, employee_count, exported_by)
    values (v_cycle.organization_id, v_serial, v_cycle.id, v_cycle.published_version, 'payslip', 'pdf', 1, v_me);

    update payslip_requests set status = 'sending', attempt_id = v_attempt, sending_started_at = now(), attempts = attempts + 1,
        handled_by = v_me, cycle_version = v_cycle.published_version, recipient_email = v_email, export_serial = v_serial, updated_at = now()
    where id = p_request_id;

    return jsonb_build_object(
        'attemptId', v_attempt,
        'requestId', p_request_id,
        'organizationId', v_cycle.organization_id,
        'userId', v_request.user_id,
        'to', v_email,
        'language', coalesce(v_user.preferred_language, 'ar'),
        'serial', v_serial,
        'organization', (select jsonb_build_object('name', name, 'logoUrl', logo_url) from organizations where id = v_cycle.organization_id),
        'cycle', jsonb_build_object('id', v_cycle.id, 'title', v_cycle.title, 'periodStart', v_cycle.period_start, 'periodEnd', v_cycle.period_end,
                                    'cycleVersion', v_cycle.published_version),
        'settings', jsonb_build_object('taxNotice', v_cycle.policy_snapshot ->> 'tax_notice', 'footerNote', v_cycle.policy_snapshot ->> 'footer_note',
                                       'reportLanguage', coalesce(v_cycle.policy_snapshot ->> 'report_language', 'bilingual')),
        -- payslip lines only: the lines in the net, never the extra allowances
        'employee', (v_emp - 'lines') || jsonb_build_object('lines', coalesce((
            select jsonb_agg(l order by (l ->> 'sort_order')::int, l ->> 'name_ar') from jsonb_array_elements(v_emp -> 'lines') l
            where (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean), '[]'::jsonb))
    );
end;
$$;
revoke all on function public.claim_prosm_time_payslip_email(uuid) from public, anon;
grant execute on function public.claim_prosm_time_payslip_email(uuid) to authenticated;

-- Step 3: the real outcome of the email, for the attempt that reserved it.
create or replace function public.complete_prosm_time_payslip_email(p_request_id uuid, p_attempt_id uuid, p_sent boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request payslip_requests%rowtype;
    v_cycle payroll_cycles%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_request from payslip_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    if v_request.status <> 'sending' or v_request.attempt_id is distinct from p_attempt_id or v_request.handled_by is distinct from v_me then
        raise exception 'THIS SENDING ATTEMPT IS NOT YOURS OR IS OVER';
    end if;
    select * into v_cycle from payroll_cycles where id = v_request.cycle_id;
    update payslip_requests set
        status = case when p_sent then 'sent' else 'failed' end,
        sent_at = case when p_sent then now() end,
        last_error = case when p_sent then null else left(coalesce(p_error, 'unknown error'), 500) end,
        attempt_id = null, updated_at = now()
    where id = p_request_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (v_request.organization_id, v_me, v_request.user_id,
            case when p_sent then 'payroll.payslip_emailed' else 'payroll.payslip_email_failed' end,
            'payslip_requests', p_request_id,
            case when p_sent then 'Payslip emailed to ' || v_request.recipient_email else 'Payslip email to ' || v_request.recipient_email || ' failed' end,
            jsonb_build_object('requesterId', v_request.user_id, 'senderId', v_me, 'recipientEmail', v_request.recipient_email,
                               'cycleId', v_request.cycle_id, 'cycleTitle', v_cycle.title, 'cycleVersion', v_request.cycle_version,
                               'exportSerial', v_request.export_serial, 'attempt', v_request.attempts, 'sent', p_sent,
                               'error', case when p_sent then null else left(coalesce(p_error, 'unknown error'), 500) end, 'at', now()));

    if p_sent then
        perform public.create_prosm_time_notification(v_request.organization_id, v_request.user_id, 'payslip_sent', 'normal',
            'Your payslip was emailed', 'Your payslip of ' || v_cycle.title || ' was sent to your email.', 'payslip_requests', p_request_id,
            jsonb_build_object('cycleTitle', v_cycle.title));
    else
        perform public.create_prosm_time_notification(v_request.organization_id, v_me, 'payslip_send_failed', 'normal',
            'Payslip email failed', 'The payslip email could not be sent. You can try again.', 'payslip_requests', p_request_id,
            jsonb_build_object('cycleTitle', v_cycle.title));
    end if;
    return jsonb_build_object('success', true, 'status', case when p_sent then 'sent' else 'failed' end);
end;
$$;
revoke all on function public.complete_prosm_time_payslip_email(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.complete_prosm_time_payslip_email(uuid, uuid, boolean, text) to authenticated;

-- Reopening a cycle closes its open requests (the payslip is no longer published).
create or replace function public.prosm_time_close_payslip_requests_on_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.published_version is null and old.published_version is not null then
        update payslip_requests set status = 'failed', last_error = 'The payslip was withdrawn (cycle reopened or unpublished).', attempt_id = null, updated_at = now()
        where cycle_id = new.id and status in ('pending', 'sending');
    end if;
    return null;
end;
$$;
revoke all on function public.prosm_time_close_payslip_requests_on_reopen() from public, anon, authenticated;
drop trigger if exists payroll_cycles_close_payslip_requests on public.payroll_cycles;
create trigger payroll_cycles_close_payslip_requests after update of published_version on public.payroll_cycles
    for each row execute function public.prosm_time_close_payslip_requests_on_reopen();

commit;
