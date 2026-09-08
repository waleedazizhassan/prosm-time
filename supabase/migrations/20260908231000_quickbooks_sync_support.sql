-- PROSM Time - service-role-only surface the QuickBooks sync/callback
-- Edge Functions need: reading a connection's own tokens (never via a
-- client role - matches quickbooks_connections' own "no grants at all
-- to anon/authenticated" posture from the previous migration), writing
-- tokens back after a real Intuit token exchange or refresh, tracking
-- which attendance_sessions rows have already been pushed as a
-- QuickBooks TimeActivity (so a re-run of Sync Now never double-posts
-- the same shift), and recording each sync run's own outcome for the
-- Settings UI to show.
--
-- quickbooks_synced_at/quickbooks_time_activity_id live on
-- attendance_sessions rather than a separate join table because the
-- relationship really is 1:1 (one completed session becomes at most
-- one QuickBooks TimeActivity) and every other export/reporting query
-- in this codebase already reads straight from attendance_sessions.

begin;

alter table public.attendance_sessions
    add column if not exists quickbooks_synced_at timestamptz,
    add column if not exists quickbooks_time_activity_id text;

create index if not exists attendance_sessions_quickbooks_unsynced_idx
    on public.attendance_sessions (organization_id, clock_out_at)
    where quickbooks_synced_at is null and clock_out_at is not null;

create or replace function public.upsert_prosm_time_quickbooks_connection(
    p_organization_id uuid,
    p_realm_id text,
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
    insert into quickbooks_connections (
        organization_id, realm_id, company_name, access_token, refresh_token,
        access_token_expires_at, refresh_token_expires_at, connected_by, connected_at, enabled, updated_at
    )
    values (
        p_organization_id, p_realm_id, p_company_name, p_access_token, p_refresh_token,
        p_access_token_expires_at, p_refresh_token_expires_at, p_connected_by, now(), true, now()
    )
    on conflict (organization_id) do update set
        realm_id = excluded.realm_id,
        company_name = coalesce(excluded.company_name, quickbooks_connections.company_name),
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
        raise exception 'UPSERT PROSM TIME QUICKBOOKS CONNECTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.get_prosm_time_quickbooks_connection_for_sync(p_organization_id uuid)
returns table (
    realm_id text,
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
    select c.realm_id, c.access_token, c.refresh_token, c.access_token_expires_at, c.refresh_token_expires_at, c.enabled
    from quickbooks_connections c
    where c.organization_id = p_organization_id;
end;
$function$;

create or replace function public.record_prosm_time_quickbooks_token_refresh(
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
    update quickbooks_connections
    set access_token = p_access_token,
        refresh_token = p_refresh_token,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        updated_at = now()
    where organization_id = p_organization_id;
end;
$function$;

-- Completed, not-yet-synced sessions with a QuickBooks-matchable
-- employee email. worked_minutes mirrors list_prosm_time_attendance_
-- export's own computation (clock_out - clock_in - break time) so
-- QuickBooks receives the same figure the rest of the product already
-- treats as the authoritative worked duration.
create or replace function public.list_prosm_time_unsynced_sessions_for_quickbooks(
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
      and s.quickbooks_synced_at is null
      and u.email is not null
    order by s.clock_out_at asc
    limit p_limit;
end;
$function$;

create or replace function public.record_prosm_time_quickbooks_session_synced(
    p_session_id uuid,
    p_time_activity_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update attendance_sessions
    set quickbooks_synced_at = now(),
        quickbooks_time_activity_id = p_time_activity_id
    where id = p_session_id;
end;
$function$;

create or replace function public.record_prosm_time_quickbooks_sync_result(
    p_organization_id uuid,
    p_summary jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update quickbooks_connections
    set last_synced_at = now(),
        last_sync_summary = p_summary,
        updated_at = now()
    where organization_id = p_organization_id;
end;
$function$;

-- All service_role-only: no anon/authenticated/public execute at all.
-- These functions read/write raw OAuth tokens or bulk-touch attendance
-- rows without any per-caller permission check of their own - they
-- MUST only ever run from within a service-role Edge Function that has
-- already established the caller's own authorization itself.
revoke execute on function public.upsert_prosm_time_quickbooks_connection(uuid, text, text, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.get_prosm_time_quickbooks_connection_for_sync(uuid) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_quickbooks_token_refresh(uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.list_prosm_time_unsynced_sessions_for_quickbooks(uuid, int) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_quickbooks_session_synced(uuid, text) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_quickbooks_sync_result(uuid, jsonb) from public, anon, authenticated;

commit;
