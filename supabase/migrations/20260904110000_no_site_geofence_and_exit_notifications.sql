-- PROSM Time - live UX review, user-directed: "control every employee
-- the same way, whether they clocked in at a registered site or not."
-- Two real gaps closed here:
--
-- 1. A no-site (manual workplace) clock-in never had ANY geofence to
--    check against - "nothing to check" was correct when the employee
--    genuinely could be anywhere, but the org can now configure one
--    radius (organization_settings.no_site_allowed_radius_meters) that
--    applies the instant a no-site employee clocks in: their own
--    clock-in GPS point becomes the center of their allowed range for
--    that session, exactly like a real site's own radius. This reuses
--    presence_sessions/record_prosm_time_presence_sample (WP-10, mid-
--    shift exit already built in 20260903100000) rather than a new
--    monitoring mechanism - presence_sessions.site_id is now nullable,
--    with a new anchor_latitude/anchor_longitude/radius_meters trio
--    used only when there's no real site to reference.
--
-- 2. A mid-shift geofence exit (site-based OR now no-site) only ever
--    played a local sound + opened an exception the employee could see
--    - the manager was never actually notified (record_prosm_time_
--    presence_sample never called notify_prosm_time_supervisors at
--    all). Real background push notifications and true "detects exits
--    even while the app is fully closed" tracking were both explicitly
--    descoped (Android background-location + Play Console review risk,
--    and no Firebase project for this app) - this stays within the
--    existing in-app notification bell + foreground sampling, but now
--    actually reaches the manager, matching what clock-in/out-time
--    exceptions already do.

begin;

-- ============================================================
-- 1. Org-wide no-site radius setting.
-- ============================================================

alter table public.organization_settings
    add column no_site_allowed_radius_meters integer not null default 500;

create or replace function public.set_prosm_time_no_site_radius(p_radius_meters integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY SET THE NO-SITE RADIUS';
    end if;

    if p_radius_meters is null or p_radius_meters <= 0 then
        raise exception 'RADIUS MUST BE GREATER THAN ZERO';
    end if;

    v_org_id := public.current_prosm_time_organization_id();
    if v_org_id is null then
        raise exception 'NO ORGANIZATION FOR THIS SESSION';
    end if;

    update organization_settings set no_site_allowed_radius_meters = p_radius_meters, updated_at = now() where organization_id = v_org_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME NO SITE RADIUS FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.set_prosm_time_no_site_radius(integer) from public, anon;
grant execute on function public.set_prosm_time_no_site_radius(integer) to authenticated;

-- ============================================================
-- 2. presence_sessions - site_id now nullable, a new anchor trio used
--    only for a no-site session (exactly one of the two sources, same
--    shape geofence_exceptions already uses for its own two sources).
-- ============================================================

alter table public.presence_sessions
    alter column site_id drop not null,
    add column anchor_latitude double precision,
    add column anchor_longitude double precision,
    add column radius_meters integer;

alter table public.presence_sessions
    add constraint presence_sessions_site_or_anchor check (
        (site_id is not null and anchor_latitude is null and anchor_longitude is null and radius_meters is null)
        or (site_id is null and anchor_latitude is not null and anchor_longitude is not null and radius_meters is not null)
    );

-- ============================================================
-- 3. clock_in_prosm_time_attendance - a no-site clock-in with a real
--    GPS sample now also opens a presence session anchored at that
--    point (no GPS at all -> nothing to anchor to, same "nothing to
--    check" posture as everywhere else in this schema). Body otherwise
--    identical to 20260904100000_attendance_note_activity.sql's own
--    version (the latest before this one).
-- ============================================================

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null,
    p_note text default null,
    p_activity text default null
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
    v_exception_id uuid;
    v_manual_label text;
    v_is_exempt boolean;
    v_caller_name text;
    v_walkin_check jsonb;
    v_no_site_radius integer;
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
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', now(), v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), '')
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        select full_name into v_caller_name from users where id = v_caller_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            v_caller_name || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_caller_name, 'distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    elsif p_site_id is null and p_latitude is not null and p_longitude is not null then
        -- § live UX review, user-directed - "control every employee the
        -- same way, whether clocked in at a site or not." The clock-in
        -- point itself becomes the center of the org's configured
        -- no-site radius for the rest of this session.
        select no_site_allowed_radius_meters into v_no_site_radius from organization_settings where organization_id = v_caller_org;
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, null, p_latitude, p_longitude, coalesce(v_no_site_radius, 500), 'active', now())
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

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text) to authenticated;

-- ============================================================
-- 4. record_prosm_time_presence_sample - geofence check now branches
--    on whether this presence session has a real site (existing
--    compute_prosm_time_geofence_check) or an anchor point (a direct
--    haversine check against it, same formula compute_prosm_time_
--    geofence_check itself uses). Also now actually notifies the
--    employee + their manager on a real mid-shift exit - previously
--    silent server-side (only a local device sound + the exception
--    row), regardless of whether the session is site-based or no-site.
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
    v_geofence jsonb;
    v_exception_created boolean := false;
    v_exception_id uuid;
    v_distance_meters double precision;
    v_caller_name text;
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

    if v_session.site_id is not null then
        v_geofence := public.compute_prosm_time_geofence_check(v_session.site_id, p_latitude, p_longitude, p_accuracy_meters);
    else
        v_distance_meters := 6371000 * 2 * asin(sqrt(
            power(sin(radians(p_latitude - v_session.anchor_latitude) / 2), 2) +
            cos(radians(v_session.anchor_latitude)) * cos(radians(p_latitude)) *
            power(sin(radians(p_longitude - v_session.anchor_longitude) / 2), 2)
        ));
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_session.radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters
        );
    end if;

    if coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = false then
        if not exists (
            select 1 from geofence_exceptions
            where presence_session_id = p_presence_session_id
            and status in ('pending_reason', 'pending_review')
        ) then
            insert into geofence_exceptions (organization_id, user_id, presence_session_id, distance_meters, status)
            values (v_session.organization_id, v_caller_id, p_presence_session_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
            returning id into v_exception_id;
            v_exception_created := true;

            select full_name into v_caller_name from users where id = v_caller_id;

            perform public.create_prosm_time_notification(
                v_session.organization_id, v_caller_id, 'out_of_zone_employee', 'normal',
                'You are outside your assigned work area',
                'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
                'geofence_exceptions', v_exception_id,
                jsonb_build_object('distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
            );
            perform public.notify_prosm_time_supervisors(
                v_session.organization_id, 'out_of_zone_manager', 'normal', 'Employee left their work area',
                v_caller_name || ' left the assigned area during their shift.',
                'geofence_exceptions', v_exception_id,
                jsonb_build_object('employeeName', v_caller_name, 'distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
            );
        end if;
    end if;

    return jsonb_build_object(
        'success', true, 'sampleId', v_sample_id,
        'geofence', v_geofence, 'exceptionCreated', v_exception_created
    );
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.record_prosm_time_presence_sample(uuid, double precision, double precision, double precision, timestamptz) to authenticated;

commit;
