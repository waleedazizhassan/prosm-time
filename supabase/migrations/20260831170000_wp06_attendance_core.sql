-- PROSM Time Implementation Master File V3.0, WP-06 (§17 "Attendance
-- Lifecycle", §35 "Backend & API Architecture"). Scope is deliberately
-- narrow, matching WP-06's own row in §38: "Clock In/Out, server
-- validation, idempotency, attendance lifecycle" - GPS/geofence
-- VALIDATION is WP-09's job, camera evidence is WP-08's, presence
-- monitoring/periodic location sampling is WP-10's, out-of-zone
-- exceptions are WP-11's, breaks/overtime are WP-12's. This package
-- only builds the real, working Clock In -> Clock Out mechanics: a
-- raw location sample is captured per event (columns exist, schema-
-- ready for those later packages) but never validated against a
-- geofence here.
--
-- §17's full lifecycle (Scheduled -> Clock-In Pending -> Clocked-In ->
-- Presence Active -> Exception -> Clocked-Out -> Under Review ->
-- Approved -> Locked) has no "Scheduled"/"Clock-In Pending" states
-- reachable yet - no work_schedules/shifts concept exists in any WP
-- row to schedule against, and inventing one is exactly the kind of
-- unscoped expansion the current instruction forbids. attendance_
-- sessions.status is a real, extensible check constraint (only
-- 'clocked_in'/'clocked_out' reachable via this package's own RPCs),
-- not the full state machine name-for-name - later packages add the
-- remaining transitions against this same table, not a new one.

-- ============================================================
-- 1. attendance_sessions - one row per Clock-In -> Clock-Out cycle.
-- ============================================================

create table public.attendance_sessions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete restrict,
    project_id uuid references public.projects(id) on delete set null,
    status text not null default 'clocked_in' check (status in ('clocked_in', 'clocked_out')),
    clock_in_at timestamptz not null default now(),
    clock_out_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index attendance_sessions_organization_id_idx on public.attendance_sessions(organization_id);
create index attendance_sessions_user_id_idx on public.attendance_sessions(user_id);

-- Only one open (clocked_in) session per employee at a time - the real
-- DB-level backstop behind the RPC's own "YOU ARE ALREADY CLOCKED IN"
-- check, closing the race a second concurrent Clock In could otherwise
-- slip through.
create unique index attendance_sessions_one_open_per_user
    on public.attendance_sessions (user_id)
    where status = 'clocked_in';

-- ============================================================
-- 2. attendance_events - append-only event log. occurred_at is the
--    server-authoritative timestamp (§35: "Server timestamps are
--    authoritative event time; client-captured timestamps are
--    preserved for offline transparency"). idempotency_key + the
--    unique constraint below is the real mechanism behind §35's
--    "Idempotency keys protect Clock In/Out... from duplicate
--    submissions, including offline-queued retries."
-- ============================================================

create table public.attendance_events (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    event_type text not null check (event_type in ('clock_in', 'clock_out')),
    occurred_at timestamptz not null default now(),
    client_reported_at timestamptz,
    latitude double precision,
    longitude double precision,
    accuracy_meters double precision,
    idempotency_key text not null,
    created_at timestamptz not null default now(),
    unique (user_id, idempotency_key)
);

create index attendance_events_session_id_idx on public.attendance_events(session_id);
create index attendance_events_user_id_idx on public.attendance_events(user_id);

-- ============================================================
-- 3. RLS - an employee always sees their own attendance; org-wide
--    visibility requires the real 'attendance.view' permission (or
--    Owner), matching WP-04's permission catalog exactly (attendance
--    was never a blanket-visible resource).
-- ============================================================

alter table public.attendance_sessions enable row level security;
alter table public.attendance_events enable row level security;

revoke all on public.attendance_sessions from anon, authenticated;
revoke all on public.attendance_events from anon, authenticated;

grant select on public.attendance_sessions to authenticated;
grant select on public.attendance_events to authenticated;

create policy "members can view their own attendance sessions or org-wide with attendance.view"
on public.attendance_sessions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

create policy "members can view their own attendance events or org-wide with attendance.view"
on public.attendance_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = attendance_events.session_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- ============================================================
-- 4. Clock In / Clock Out RPCs. Both derive the caller from
--    current_prosm_time_user_id() (never a client-supplied user id) -
--    granted to `authenticated`, called by the clock-in/clock-out Edge
--    Functions (§35) which forward the caller's own session, exactly
--    like set_prosm_time_user_permission_override's own auth shape.
--    Real idempotent-replay semantics: a retried key returns the
--    already-created result instead of erroring or duplicating.
-- ============================================================

create or replace function public.clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_idempotency_key text,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
        raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, v_caller_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key
    )
    returning id into v_event_id;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.clock_out_prosm_time_attendance(
    p_idempotency_key text,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_event_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN';
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.clock_in_prosm_time_attendance(uuid, text, uuid, timestamptz, double precision, double precision, double precision) to authenticated;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision) to authenticated;
