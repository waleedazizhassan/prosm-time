-- PROSM Time Implementation Master File V3.0, WP-10 (§18 "Presence
-- Session Lifecycle"). Scope per WP-10's own row in §38: "Active
-- presence sessions, controlled location sampling, SOS action."
--
-- §18: "Created at successful Clock In when presence monitoring is
-- enabled. Active while the employee is within an authorized work
-- session; location samples collected per policy and platform
-- capability... SOS/Emergency action is reachable at all times during
-- an active session... Session ends at Clock Out or controlled
-- termination; no active presence tracking after Clock Out."
--
-- Deliberately NOT built here (WP-11's own separate row, "Out-of-zone
-- detection, employee reason, correction requests, manager workflow,
-- audit"): §18's own "out-of-zone detection creates a Presence
-- Exception... employee is notified... manager receives an alert" -
-- this pass records real location samples and a real SOS trigger, but
-- never evaluates them against a geofence or raises any exception/
-- notification. That consequence logic belongs entirely to WP-11.
--
-- A presence session is created only for the employee's own
-- self-service Clock In, never an administrative on-behalf one
-- (WP-07): presence monitoring is inherently the employee's own
-- device periodically sampling its location, and an on-behalf Clock
-- In exists specifically because the employee's own device/app isn't
-- being used right now (§10) - there is nothing to monitor.

-- ============================================================
-- 1. sites.presence_monitoring_enabled - the per-site policy toggle
--    §18 requires ("when presence monitoring is enabled"), added the
--    same way every other site policy flag already was (WP-05).
-- ============================================================

alter table public.sites
    add column presence_monitoring_enabled boolean not null default false;

-- ============================================================
-- 2. presence_sessions - one row per attendance session that actually
--    had presence monitoring enabled at Clock In time.
-- ============================================================

create table public.presence_sessions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    attendance_session_id uuid not null unique references public.attendance_sessions(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete restrict,
    status text not null default 'active' check (status in ('active', 'ended')),
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    end_reason text check (end_reason in ('clock_out', 'manual_termination')),
    created_at timestamptz not null default now()
);

create index presence_sessions_organization_id_idx on public.presence_sessions(organization_id);
create index presence_sessions_user_id_idx on public.presence_sessions(user_id);

-- Only one active presence session per employee at a time - mirrors
-- attendance_sessions' own one-open-session backstop (WP-06).
create unique index presence_sessions_one_active_per_user
    on public.presence_sessions (user_id)
    where status = 'active';

-- ============================================================
-- 3. location_samples - periodic samples collected during an active
--    presence session (§18: "location samples collected per policy
--    and platform capability") - distinct from the single clock-in/
--    clock-out sample already stored on attendance_events (WP-06/09).
-- ============================================================

create table public.location_samples (
    id uuid primary key default gen_random_uuid(),
    presence_session_id uuid not null references public.presence_sessions(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    latitude double precision not null,
    longitude double precision not null,
    accuracy_meters double precision,
    captured_at timestamptz not null default now(),
    client_reported_at timestamptz
);

create index location_samples_presence_session_id_idx on public.location_samples(presence_session_id);

-- ============================================================
-- 4. sos_alerts - §3.1/§34. Recording and resolution only this pass;
--    priority delivery/escalation is explicitly WP-13's own row
--    ("Notifications... SOS priority delivery").
-- ============================================================

create table public.sos_alerts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    presence_session_id uuid not null references public.presence_sessions(id) on delete cascade,
    triggered_at timestamptz not null default now(),
    latitude double precision,
    longitude double precision,
    accuracy_meters double precision,
    status text not null default 'active' check (status in ('active', 'resolved')),
    resolved_at timestamptz,
    resolved_by uuid references public.users(id) on delete set null,
    resolution_notes text,
    created_at timestamptz not null default now()
);

create index sos_alerts_organization_id_idx on public.sos_alerts(organization_id);
create index sos_alerts_user_id_idx on public.sos_alerts(user_id);
create index sos_alerts_status_idx on public.sos_alerts(status);

-- ============================================================
-- 5. RLS - same visibility posture as attendance_sessions/events
--    (WP-06): the subject always sees their own; org-wide visibility
--    requires the real 'attendance.view' permission (or Owner). All
--    writes go through the RPCs below - no direct grant to
--    authenticated beyond select.
-- ============================================================

alter table public.presence_sessions enable row level security;
alter table public.location_samples enable row level security;
alter table public.sos_alerts enable row level security;

revoke all on public.presence_sessions from anon, authenticated;
revoke all on public.location_samples from anon, authenticated;
revoke all on public.sos_alerts from anon, authenticated;

grant select on public.presence_sessions to authenticated;
grant select on public.location_samples to authenticated;
grant select on public.sos_alerts to authenticated;

create policy "presence sessions visible to subject or attendance.view"
on public.presence_sessions for select to authenticated
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

create policy "location samples visible to subject or attendance.view"
on public.location_samples for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from presence_sessions ps
        where ps.id = location_samples.presence_session_id
        and ps.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

create policy "sos alerts visible to subject or attendance.view"
on public.sos_alerts for select to authenticated
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

-- ============================================================
-- 6. Re-point clock_in/clock_out_prosm_time_attendance (WP-06) to
--    open/close a presence session when the site's own policy calls
--    for it. Same signatures, same Edge Functions, only the bodies
--    change. admin_clock_in/admin_clock_out (WP-07) are intentionally
--    NOT touched - see this migration's own header comment on why an
--    on-behalf Clock In never starts presence monitoring.
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
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
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

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then
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

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, v_caller_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false,
        'geofence', v_geofence, 'presenceSessionId', v_presence_session_id
    );
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
    v_geofence jsonb;
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

    v_geofence := public.compute_prosm_time_geofence_check(v_open_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    -- §18: "Session ends at Clock Out... no active presence tracking
    -- after Clock Out."
    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'replay', false, 'geofence', v_geofence);
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

-- ============================================================
-- 7. Controlled termination (§18: "...or controlled termination") -
--    an administrative override to end presence tracking before
--    Clock Out. Gated on the same authority as an on-behalf attendance
--    action (WP-07's 'attendance.clock_out_on_behalf', or Owner) -
--    reuses that existing permission rather than adding a new
--    catalog entry for what is the same class of "authorized
--    administrative intervention on someone's active attendance
--    state."
-- ============================================================

create or replace function public.end_prosm_time_presence_session(
    p_presence_session_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session presence_sessions%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id and organization_id = v_caller_org;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS ALREADY ENDED';
    end if;

    update presence_sessions set status = 'ended', ended_at = now(), end_reason = 'manual_termination' where id = p_presence_session_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_session.user_id, 'PRESENCE_SESSION_TERMINATED', 'presence_sessions', p_presence_session_id,
        'Presence monitoring ended by controlled termination.', p_reason
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'END PROSM TIME PRESENCE SESSION FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.end_prosm_time_presence_session(uuid, text) to authenticated;

-- ============================================================
-- 8. Location sampling - self-service, direct RPC (not Edge-Function-
--    mediated; §35's own explicit list of Edge-Function flows does
--    not name presence sampling, unlike Clock In/Out/SOS). Caller
--    must be the presence session's own subject.
-- ============================================================

create or replace function public.record_prosm_time_presence_sample(
    p_presence_session_id uuid,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_session presence_sessions%rowtype;
    v_sample_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_latitude is null or p_longitude is null then
        raise exception 'LATITUDE AND LONGITUDE ARE REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS NOT ACTIVE';
    end if;

    insert into location_samples (presence_session_id, user_id, latitude, longitude, accuracy_meters, client_reported_at)
    values (p_presence_session_id, v_caller_id, p_latitude, p_longitude, p_accuracy_meters, p_client_reported_at)
    returning id into v_sample_id;

    return jsonb_build_object('success', true, 'sampleId', v_sample_id);
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.record_prosm_time_presence_sample(uuid, double precision, double precision, double precision, timestamptz) to authenticated;

-- ============================================================
-- 9. SOS - real trigger + resolution recording only (§34/§3.1); the
--    Edge Function (trigger-sos-alert) is required by §35's explicit
--    list, priority delivery/escalation is WP-13's own separate row.
-- ============================================================

create or replace function public.trigger_prosm_time_sos_alert(
    p_presence_session_id uuid,
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
    v_session presence_sessions%rowtype;
    v_alert_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'SOS REQUIRES AN ACTIVE PRESENCE SESSION';
    end if;

    insert into sos_alerts (organization_id, user_id, presence_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, p_presence_session_id, p_latitude, p_longitude, p_accuracy_meters)
    returning id into v_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active presence session.',
        jsonb_build_object('presenceSessionId', p_presence_session_id)
    );

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.resolve_prosm_time_sos_alert(
    p_sos_alert_id uuid,
    p_resolution_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_alert sos_alerts%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    select * into v_alert from sos_alerts where id = p_sos_alert_id and organization_id = v_caller_org;
    if v_alert.id is null then
        raise exception 'SOS ALERT NOT FOUND';
    end if;

    if v_alert.status <> 'active' then
        raise exception 'THIS SOS ALERT IS ALREADY RESOLVED';
    end if;

    update sos_alerts
    set status = 'resolved', resolved_at = now(), resolved_by = v_caller_id, resolution_notes = p_resolution_notes
    where id = p_sos_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, v_alert.user_id, 'SOS_ALERT_RESOLVED', 'sos_alerts', p_sos_alert_id,
        'SOS alert marked resolved.'
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'RESOLVE PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.resolve_prosm_time_sos_alert(uuid, text) to authenticated;
