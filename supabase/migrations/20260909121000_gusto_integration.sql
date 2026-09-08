-- PROSM Time - Gusto payroll integration scaffolding, mirroring the
-- QuickBooks Online integration (20260908230000-20260908233000) and
-- the Xero one (20260909120000) exactly in shape and security posture.
-- Third payroll provider option for the Settings > Payroll Integration
-- selector - user-directed 2026-09-09.
--
-- Deliberately dormant: no GUSTO_CLIENT_ID/GUSTO_CLIENT_SECRET exist as
-- Supabase secrets yet - gusto-authorize returns NOT_CONFIGURED until
-- those are set, same as the other two providers.
--
-- Gusto's own company identifier is company_id, returned directly in
-- its token response (unlike Xero's tenant_id, which needs a separate
-- discovery call) - see gusto-oauth-callback for the exact field name
-- as documented in Gusto's OAuth docs at the time this was written.

begin;

create table public.gusto_connections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    company_id text not null,
    company_name text,
    access_token text not null,
    refresh_token text not null,
    access_token_expires_at timestamptz not null,
    refresh_token_expires_at timestamptz not null,
    enabled boolean not null default true,
    connected_by uuid references public.users(id) on delete set null,
    connected_at timestamptz not null default now(),
    last_synced_at timestamptz,
    last_sync_summary jsonb,
    updated_at timestamptz not null default now()
);

alter table public.gusto_connections enable row level security;
revoke all on public.gusto_connections from anon, authenticated;

create table public.gusto_oauth_states (
    state text primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

alter table public.gusto_oauth_states enable row level security;
revoke all on public.gusto_oauth_states from anon, authenticated;

create or replace function public.start_prosm_time_gusto_connection()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_state text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CONNECT GUSTO';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_state := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

    delete from gusto_oauth_states where organization_id = v_org;
    insert into gusto_oauth_states (state, organization_id, created_by, expires_at)
    values (v_state, v_org, v_caller_id, now() + interval '10 minutes');

    return jsonb_build_object('success', true, 'state', v_state);
exception
    when others then
        raise exception 'START PROSM TIME GUSTO CONNECTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.disconnect_prosm_time_gusto()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY DISCONNECT GUSTO';
    end if;

    v_org := public.current_prosm_time_organization_id();
    delete from gusto_connections where organization_id = v_org;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'GUSTO_DISCONNECTED', 'gusto_connections', v_org, 'Disconnected the Gusto integration.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DISCONNECT PROSM TIME GUSTO FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.get_prosm_time_gusto_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_row gusto_connections%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY VIEW THE GUSTO CONNECTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_row from gusto_connections where organization_id = v_org;

    if v_row.id is null then
        return jsonb_build_object('connected', false, 'companyName', null, 'enabled', false, 'lastSyncedAt', null, 'lastSyncSummary', null);
    end if;

    return jsonb_build_object(
        'connected', true,
        'companyName', v_row.company_name,
        'enabled', v_row.enabled,
        'connectedAt', v_row.connected_at,
        'lastSyncedAt', v_row.last_synced_at,
        'lastSyncSummary', v_row.last_sync_summary
    );
exception
    when others then
        raise exception 'GET PROSM TIME GUSTO STATUS FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.consume_prosm_time_gusto_oauth_state(p_state text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
begin
    delete from gusto_oauth_states
    where state = p_state and expires_at > now()
    returning organization_id into v_org;

    return v_org;
end;
$function$;

create or replace function public.upsert_prosm_time_gusto_connection(
    p_organization_id uuid,
    p_company_id text,
    p_company_name text,
    p_access_token text,
    p_refresh_token text,
    p_access_token_expires_at timestamptz,
    p_refresh_token_expires_at timestamptz,
    p_connected_by uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    insert into gusto_connections (
        organization_id, company_id, company_name, access_token, refresh_token,
        access_token_expires_at, refresh_token_expires_at, connected_by, connected_at, enabled, updated_at
    )
    values (
        p_organization_id, p_company_id, p_company_name, p_access_token, p_refresh_token,
        p_access_token_expires_at, p_refresh_token_expires_at, p_connected_by, now(), true, now()
    )
    on conflict (organization_id) do update set
        company_id = excluded.company_id,
        company_name = coalesce(excluded.company_name, gusto_connections.company_name),
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        connected_by = excluded.connected_by,
        connected_at = now(),
        enabled = true,
        updated_at = now();
exception
    when others then
        raise exception 'UPSERT PROSM TIME GUSTO CONNECTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.get_prosm_time_gusto_connection_for_sync(p_organization_id uuid)
returns table (
    company_id text,
    access_token text,
    refresh_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    enabled boolean
)
language plpgsql
security definer
set search_path = public
as $function$
begin
    return query
    select c.company_id, c.access_token, c.refresh_token, c.access_token_expires_at, c.refresh_token_expires_at, c.enabled
    from gusto_connections c
    where c.organization_id = p_organization_id;
end;
$function$;

create or replace function public.record_prosm_time_gusto_token_refresh(
    p_organization_id uuid,
    p_access_token text,
    p_refresh_token text,
    p_access_token_expires_at timestamptz,
    p_refresh_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update gusto_connections
    set access_token = p_access_token,
        refresh_token = p_refresh_token,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        updated_at = now()
    where organization_id = p_organization_id;
end;
$function$;

alter table public.attendance_sessions
    add column if not exists gusto_synced_at timestamptz,
    add column if not exists gusto_external_id text;

create index if not exists attendance_sessions_gusto_unsynced_idx
    on public.attendance_sessions (organization_id, clock_out_at)
    where gusto_synced_at is null and clock_out_at is not null;

create or replace function public.list_prosm_time_unsynced_sessions_for_gusto(
    p_organization_id uuid,
    p_limit int default 50
)
returns table (
    session_id uuid,
    employee_email text,
    employee_name text,
    work_date date,
    clock_in_at timestamptz,
    clock_out_at timestamptz,
    worked_minutes int
)
language plpgsql
security definer
set search_path = public
as $function$
begin
    return query
    select
        s.id as session_id,
        u.email as employee_email,
        u.full_name as employee_name,
        (s.clock_in_at at time zone 'UTC')::date as work_date,
        s.clock_in_at,
        s.clock_out_at,
        greatest(0, (extract(epoch from (s.clock_out_at - s.clock_in_at)) / 60)::int
            - coalesce((
                select sum(extract(epoch from (coalesce(be.ended_at, s.clock_out_at) - be.started_at)) / 60)::int
                from break_events be
                where be.attendance_session_id = s.id
            ), 0)
        ) as worked_minutes
    from attendance_sessions s
    join users u on u.id = s.user_id
    where s.organization_id = p_organization_id
      and s.clock_out_at is not null
      and s.gusto_synced_at is null
      and u.email is not null
    order by s.clock_out_at asc
    limit p_limit;
end;
$function$;

create or replace function public.record_prosm_time_gusto_session_synced(
    p_session_id uuid,
    p_external_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update attendance_sessions
    set gusto_synced_at = now(),
        gusto_external_id = p_external_id
    where id = p_session_id;
end;
$function$;

create or replace function public.record_prosm_time_gusto_sync_result(
    p_organization_id uuid,
    p_summary jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update gusto_connections
    set last_synced_at = now(),
        last_sync_summary = p_summary,
        updated_at = now()
    where organization_id = p_organization_id;
end;
$function$;

revoke execute on function public.start_prosm_time_gusto_connection() from public, anon;
revoke execute on function public.disconnect_prosm_time_gusto() from public, anon;
revoke execute on function public.get_prosm_time_gusto_status() from public, anon;

revoke execute on function public.consume_prosm_time_gusto_oauth_state(text) from public, anon, authenticated;
revoke execute on function public.upsert_prosm_time_gusto_connection(uuid, text, text, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.get_prosm_time_gusto_connection_for_sync(uuid) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_gusto_token_refresh(uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.list_prosm_time_unsynced_sessions_for_gusto(uuid, int) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_gusto_session_synced(uuid, text) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_gusto_sync_result(uuid, jsonb) from public, anon, authenticated;

commit;
