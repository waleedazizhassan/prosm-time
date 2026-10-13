-- Audit 2026-10-12, item 1.4 - employees could choose their own clock
-- time. Clock in/out, break start/end and site change took
-- p_client_reported_at (filled from the phone's clock) as the real time
-- whenever it was within 24 hours back, so a changed phone clock or a
-- hand-made request moved lateness, hours and overtime.
--
-- Now:
-- * A live action always uses the server's time. p_client_reported_at
--   is still stored on the event for reference, never used as the time.
-- * Only an offline replay (p_offline_replay = true, sent by the app's
--   offline queue) may use the device's time, and only within the same
--   window as before (24 h back, 5 min ahead). When it differs from the
--   server's time by more than 2 minutes it is kept, marked
--   time_source = 'device_offline', and a pending review is created for
--   the managers (Manager console, "pending review").
-- * A replayed time can never be earlier than the person's last
--   recorded action, and never on a day of approved leave.
-- Kiosk and on-behalf paths already use the server's time (unchanged).
-- New parameters have defaults, so older callers keep working - on
-- server time.

begin;

alter table public.attendance_events
    add column if not exists time_source text not null default 'server'
    constraint attendance_events_time_source_check check (time_source in ('server', 'device_offline'));
alter table public.break_events
    add column if not exists start_time_source text not null default 'server'
    constraint break_events_start_time_source_check check (start_time_source in ('server', 'device_offline'));
alter table public.break_events
    add column if not exists end_time_source text
    constraint break_events_end_time_source_check check (end_time_source in ('server', 'device_offline'));
alter table public.site_change_events
    add column if not exists time_source text not null default 'server'
    constraint site_change_events_time_source_check check (time_source in ('server', 'device_offline'));

create table if not exists public.offline_time_reviews (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    action text not null check (action in ('clock_in', 'clock_out', 'break_start', 'break_end', 'site_change')),
    source_table text not null check (source_table in ('attendance_events', 'break_events', 'site_change_events')),
    source_id uuid not null,
    device_time timestamptz not null,
    server_received_at timestamptz not null default now(),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'acknowledged')),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now()
);

create index if not exists offline_time_reviews_organization_id_idx on public.offline_time_reviews(organization_id);
create index if not exists offline_time_reviews_user_id_idx on public.offline_time_reviews(user_id);
create index if not exists offline_time_reviews_source_idx on public.offline_time_reviews(source_table, source_id);

alter table public.offline_time_reviews enable row level security;

-- Same reach as geofence_exceptions: the person themself, the Owner, and
-- attendance.view holders for the sites they manage (read-only role:
-- whole organisation) - always inside the caller's organisation.
drop policy if exists "offline time reviews visible to subject or attendance.view" on public.offline_time_reviews;
create policy "offline time reviews visible to subject or attendance.view"
on public.offline_time_reviews for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and (site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
        )
    )
);

revoke all on public.offline_time_reviews from anon;
grant select on public.offline_time_reviews to authenticated;

-- The time an attendance action is recorded at, and where it came from.
create or replace function public.resolve_prosm_time_reported_time(
    p_user_id uuid,
    p_client_reported_at timestamptz,
    p_offline_replay boolean,
    p_not_before timestamptz,
    p_site_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_last timestamptz;
    v_timezone text;
begin
    if not coalesce(p_offline_replay, false)
        or p_client_reported_at is null
        or p_client_reported_at > now() + interval '5 minutes'
        or p_client_reported_at < now() - interval '24 hours'
        or abs(extract(epoch from (now() - p_client_reported_at))) <= 120
    then
        return jsonb_build_object('time', now(), 'source', 'server');
    end if;

    v_last := greatest(
        p_not_before,
        (select max(occurred_at) from attendance_events where user_id = p_user_id),
        (select max(greatest(started_at, coalesce(ended_at, started_at))) from break_events where user_id = p_user_id),
        (select max(changed_at) from site_change_events where user_id = p_user_id)
    );
    if v_last is not null and p_client_reported_at < v_last then
        raise exception 'OFFLINE TIME IS BEFORE YOUR LAST RECORDED ACTION';
    end if;

    -- The leave day is the day at the site (UTC without one).
    select timezone into v_timezone from sites where id = p_site_id;
    if exists (
        select 1 from leave_requests
        where user_id = p_user_id
          and status = 'approved'
          and (p_client_reported_at at time zone coalesce(v_timezone, 'UTC'))::date between start_date and end_date
    ) then
        raise exception 'OFFLINE TIME FALLS ON A DAY OF APPROVED LEAVE';
    end if;

    return jsonb_build_object('time', p_client_reported_at, 'source', 'device_offline');
end;
$function$;

create or replace function public.record_prosm_time_offline_time_review(
    p_organization_id uuid,
    p_user_id uuid,
    p_site_id uuid,
    p_action text,
    p_source_table text,
    p_source_id uuid,
    p_device_time timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_id uuid;
begin
    insert into offline_time_reviews (organization_id, user_id, site_id, action, source_table, source_id, device_time)
    values (p_organization_id, p_user_id, p_site_id, p_action, p_source_table, p_source_id, p_device_time)
    returning id into v_id;
    return v_id;
end;
$function$;

revoke execute on function public.resolve_prosm_time_reported_time(uuid, timestamptz, boolean, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_offline_time_review(uuid, uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text);
drop function if exists public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text);
drop function if exists public.start_prosm_time_break(uuid, text, timestamptz);
drop function if exists public.end_prosm_time_break(uuid, text, timestamptz);
drop function if exists public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text, text, timestamptz);

create or replace function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null,
    p_note text default null,
    p_activity text default null,
    p_offline_replay boolean default false
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
    v_manual_label text;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_no_site_radius integer;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
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

    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, null, p_site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'YOU ARE ON APPROVED LEAVE TODAY';
    end if;

    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'orphan_auto_closed'
    where user_id = v_caller_id
      and status = 'active'
      and (
        attendance_session_id is null
        or not exists (
            select 1 from attendance_sessions
            where attendance_sessions.id = presence_sessions.attendance_session_id
              and attendance_sessions.status = 'clocked_in'
        )
      );

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_site_id and user_id = v_caller_id;

        if v_is_exempt is null then
            if v_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
            v_is_exempt := false;
        end if;

        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then
                raise exception 'CLOCK_IN_BLOCKED_CONTACT_MANAGER';
            end if;
        end if;

        if p_project_id is not null then
            if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
                raise exception 'PROJECT NOT FOUND AT THIS SITE';
            end if;
            if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
                raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
            end if;
        end if;
    else
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', v_effective_time, v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity, time_source
    ) values (
        v_session_id, v_caller_id, 'clock_in', v_effective_time, p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), ''), v_time_source
    )
    returning id into v_event_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, p_site_id, 'clock_in', 'attendance_events', v_event_id, v_effective_time);
    end if;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => p_site_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', v_effective_time)
        returning id into v_presence_session_id;
    elsif p_site_id is null and p_latitude is not null and p_longitude is not null then
        select no_site_allowed_radius_meters into v_no_site_radius from organization_settings where organization_id = v_caller_org;
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, null, p_latitude, p_longitude, coalesce(v_no_site_radius, 500), 'active', v_effective_time)
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
    p_accuracy_meters double precision default null,
    p_note text default null,
    p_activity text default null,
    p_offline_replay boolean default false
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
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_is_exempt boolean;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
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

        select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN';
    end if;

    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_open_session.clock_in_at, v_open_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    v_geofence := public.compute_prosm_time_geofence_check(v_open_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    if v_open_session.site_id is not null and (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        select * into v_site from sites where id = v_open_session.site_id;
        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = v_open_session.site_id and user_id = v_caller_id;

        if v_site.block_self_clock_out_outside_geofence and not coalesce(v_is_exempt, false) then
            raise exception 'CLOCK_OUT_BLOCKED_CONTACT_MANAGER';
        end if;
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity, time_source
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', v_effective_time, p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), ''), v_time_source
    )
    returning id into v_event_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, v_open_session.site_id, 'clock_out', 'attendance_events', v_event_id, v_effective_time);
    end if;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => v_open_session.site_id
        );
    end if;

    update attendance_sessions set status = 'clocked_out', clock_out_at = v_effective_time, updated_at = now() where id = v_open_session.id;

    update presence_sessions
    set status = 'ended', ended_at = v_effective_time, end_reason = 'clock_out'
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

CREATE OR REPLACE FUNCTION public.start_prosm_time_break(p_attendance_session_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_break_id uuid;
    v_existing break_events%rowtype;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is not null then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO START A BREAK'; end if;

    if exists (select 1 from break_events where attendance_session_id = p_attendance_session_id and status = 'active') then
        raise exception 'A BREAK IS ALREADY ACTIVE FOR THIS SESSION';
    end if;

    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_session.clock_in_at, v_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if v_session.site_id is not null then
        select * into v_site from sites where id = v_session.site_id;
    end if;

    insert into break_events (organization_id, attendance_session_id, user_id, paid, idempotency_key, started_at, start_time_source)
    values (v_session.organization_id, p_attendance_session_id, v_caller_id, coalesce(v_site.break_paid_by_default, true), p_idempotency_key, v_effective_time, v_time_source)
    returning id into v_break_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_session.organization_id, v_caller_id, v_session.site_id, 'break_start', 'break_events', v_break_id, v_effective_time);
    end if;

    return jsonb_build_object('success', true, 'breakId', v_break_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
    when others then
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.end_prosm_time_break(p_break_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    -- A resend of an end that already reached the server (offline sync): the same answer, never a second end.
    if p_idempotency_key is not null and v_break.end_idempotency_key = p_idempotency_key then
        return jsonb_build_object('success', true, 'maxDurationExceeded', v_break.max_duration_exceeded, 'replay', true);
    end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_break.started_at, (select site_id from attendance_sessions where id = v_break.attendance_session_id));
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    -- No site (or no site policy) to check the max duration against -
    -- never flagged as exceeded, same as it simply never being
    -- configured on a real site.
    v_exceeded := coalesce(extract(epoch from (v_effective_time - v_break.started_at)) / 60 > v_site.break_max_duration_minutes, false);

    update break_events set status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded, end_idempotency_key = p_idempotency_key, end_time_source = v_time_source where id = p_break_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_break.organization_id, v_caller_id, v_site.id, 'break_end', 'break_events', p_break_id, v_effective_time);
    end if;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_break.organization_id, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'END PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.change_prosm_time_site(p_break_id uuid DEFAULT NULL::uuid, p_new_site_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_manual_location_label text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_break break_events%rowtype;
    v_session attendance_sessions%rowtype;
    v_old_site sites%rowtype;
    v_new_site sites%rowtype;
    v_old_site_id uuid;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_exceeded boolean := false;
    v_change_id uuid;
    v_manual_label text;
    v_employee_name text;
    v_change_body text;
    v_existing_change site_change_events%rowtype;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

    -- A resend of a site change that already reached the server (offline sync): the same answer.
    if p_idempotency_key is not null then
        select * into v_existing_change from site_change_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_change.id is not null then
            return jsonb_build_object('success', true, 'siteChangeId', v_existing_change.id, 'newSiteId', v_existing_change.new_site_id, 'maxDurationExceeded', false, 'replay', true);
        end if;
    end if;

    if p_break_id is not null then
        select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
        if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
        if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

        select * into v_session from attendance_sessions where id = v_break.attendance_session_id and user_id = v_caller_id;
    else
        select * into v_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    end if;

    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO CHANGE SITE'; end if;

    v_old_site_id := v_session.site_id;
    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_session.clock_in_at, v_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if p_new_site_id is null then
        if v_old_site_id is null then
            raise exception 'YOU ARE ALREADY WORKING WITHOUT A REGISTERED SITE';
        end if;
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
        if p_latitude is null or p_longitude is null then
            raise exception 'A REAL LOCATION SAMPLE IS REQUIRED TO CHANGE TO NO SITE';
        end if;
    else
        select * into v_new_site from sites where id = p_new_site_id and organization_id = v_caller_org and is_active = true;
        if v_new_site.id is null then raise exception 'SITE NOT FOUND'; end if;

        if v_old_site_id = p_new_site_id then
            raise exception 'YOU ARE ALREADY AT THIS SITE';
        end if;

        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_new_site_id and user_id = v_caller_id;
        if v_is_exempt is null then
            if v_new_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_new_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
        end if;
    end if;

    if v_old_site_id is not null then
        select * into v_old_site from sites where id = v_old_site_id;
    end if;

    if p_break_id is not null then
        v_exceeded := coalesce(extract(epoch from (v_effective_time - v_break.started_at)) / 60 > v_old_site.break_max_duration_minutes, false);
        update break_events set status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded, end_time_source = v_time_source where id = p_break_id;
    end if;

    update attendance_sessions
    set site_id = p_new_site_id, project_id = null, manual_location_label = case when p_new_site_id is null then v_manual_label else null end
    where id = v_session.id;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters, manual_location_label, changed_at, idempotency_key, time_source)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters, v_manual_label, v_effective_time, p_idempotency_key, v_time_source)
    returning id into v_change_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, coalesce(p_new_site_id, v_old_site_id), 'site_change', 'site_change_events', v_change_id, v_effective_time);
    end if;

    -- § real gap fix, 14-point live-audit - a real alert on every
    -- mid-shift site change, scoped to whichever real site(s) are
    -- actually involved (+ the Owner, always).
    select full_name into v_employee_name from users where id = v_caller_id;
    v_change_body := v_employee_name || ' changed site mid-shift, from '
        || coalesce(v_old_site.name, 'an unregistered location') || ' to '
        || coalesce(v_new_site.name, v_manual_label, 'an unregistered location') || '.';

    if v_old_site_id is not null then
        perform public.notify_prosm_time_site_managers_or_owner(
            v_caller_org, v_old_site_id, 'site_change_alert', 'normal', 'Employee changed site mid-shift',
            v_change_body, 'site_change_events', v_change_id,
            jsonb_build_object('employeeName', v_employee_name, 'oldSiteName', v_old_site.name, 'newSiteName', coalesce(v_new_site.name, v_manual_label))
        );
    end if;
    if p_new_site_id is not null then
        perform public.notify_prosm_time_site_managers_or_owner(
            v_caller_org, p_new_site_id, 'site_change_alert', 'normal', 'Employee changed site mid-shift',
            v_change_body, 'site_change_events', v_change_id,
            jsonb_build_object('employeeName', v_employee_name, 'oldSiteName', v_old_site.name, 'newSiteName', coalesce(v_new_site.name, v_manual_label))
        );
    end if;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'siteChangeId', v_change_id, 'newSiteId', p_new_site_id, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'CHANGE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.review_prosm_time_exception(
    p_kind text,
    p_target_id uuid,
    p_action_type text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
    v_session attendance_sessions%rowtype;
    v_ot offline_time_reviews%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EXCEPTIONS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_kind not in ('geofence_exception', 'correction_request', 'offline_time') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    -- Audit 1.4 - an offline action recorded with the device's time: the
    -- decision is kept on the review itself (the recorded time stays; a
    -- correction request or an admin edit changes it when needed).
    if p_kind = 'offline_time' then
        select * into v_ot from offline_time_reviews where id = p_target_id and organization_id = v_caller_org;
        if v_ot.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;

        update offline_time_reviews
        set status = case p_action_type when 'clarification_requested' then 'pending' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_ot.user_id, 'correction_reviewed', 'normal', 'Your offline time was reviewed',
            'Decision: ' || p_action_type || '.', 'offline_time_reviews', p_target_id,
            jsonb_build_object('kind', 'offline_time', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;

        -- § live UX review, user-directed - approving now actually
        -- applies the proposed time, not just a recorded decision.
        if p_action_type = 'approved' then
            select * into v_session from attendance_sessions where id = v_cr.attendance_session_id;
            if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;

            if v_cr.proposed_event_type = 'clock_in' then
                if v_session.clock_out_at is not null and v_cr.proposed_correct_time >= v_session.clock_out_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_in_at = v_cr.proposed_correct_time, updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_in';
            else
                if v_cr.proposed_correct_time <= v_session.clock_in_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_out_at = v_cr.proposed_correct_time, status = 'clocked_out', updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_out';

                -- Same cleanup clock_out_prosm_time_attendance's own
                -- self-service path already does - a retroactive
                -- clock-out correction shouldn't leave presence
                -- monitoring running against someone no longer "at work".
                update presence_sessions
                set status = 'ended', ended_at = now(), end_reason = 'clock_out'
                where attendance_session_id = v_cr.attendance_session_id and status = 'active';
            end if;
        end if;

        perform public.create_prosm_time_notification(
            v_caller_org, v_cr.user_id, 'correction_reviewed', 'normal', 'Your correction request was reviewed',
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id,
            jsonb_build_object('kind', 'correction', 'actionType', p_action_type)
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean) from public, anon;
revoke execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text, boolean) from public, anon;
revoke execute on function public.start_prosm_time_break(uuid, text, timestamptz, boolean) from public, anon;
revoke execute on function public.end_prosm_time_break(uuid, text, timestamptz, boolean) from public, anon;
revoke execute on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text, text, timestamptz, boolean) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean) to authenticated, service_role;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text, boolean) to authenticated, service_role;
grant execute on function public.start_prosm_time_break(uuid, text, timestamptz, boolean) to authenticated, service_role;
grant execute on function public.end_prosm_time_break(uuid, text, timestamptz, boolean) to authenticated, service_role;
grant execute on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text, text, timestamptz, boolean) to authenticated, service_role;

commit;
