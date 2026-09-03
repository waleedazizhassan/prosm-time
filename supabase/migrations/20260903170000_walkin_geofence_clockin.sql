-- PROSM Time - live UX review, user-directed: "if I'm not assigned to
-- a site but I'm physically there today, shouldn't the geofence itself
-- let me clock in there?" ("I'm at a different site every day.")
--
-- Current behavior was deliberate access control (only an explicit
-- site_assignments row lets you pick a site at all) - but that's too
-- rigid for an employee who legitimately rotates sites. The fix keeps
-- the same security posture (a real, server-verified GPS check - not
-- the client's word for it) while allowing a genuine "walk-in":
-- clocking in at an unassigned site is now allowed when that site
-- itself requires geofencing AND the caller is verifiably inside it
-- right now. A site with geofence_required = false still refuses
-- unassigned self-service (no real signal to verify against), and an
-- unassigned employee outside any site's radius is refused exactly as
-- before - nothing about the existing assigned-site path changes.
--
-- New list_prosm_time_nearby_sites() is the one-time site.* RLS
-- couldn't otherwise let an unassigned employee see - a SECURITY
-- DEFINER lookup that returns ONLY sites the caller is verifiably
-- inside right now (id/name/distance only, not the full site record),
-- so the Clock In picker can suggest "you're at El Agami today" - it
-- is read-only and grants nothing by itself; clock_in_prosm_time_
-- attendance re-verifies the same geofence check server-side
-- regardless of what this returned.

begin;

create or replace function public.list_prosm_time_nearby_sites(
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null
)
returns table(id uuid, name text, display_address text, distance_meters double precision)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site record;
    v_check jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

    if p_latitude is null or p_longitude is null then
        return;
    end if;

    for v_site in
        select s.id, s.name, s.display_address
        from sites s
        where s.organization_id = v_caller_org
        and s.is_active = true
        and s.attendance_allowed = true
        and s.geofence_required = true
        and not exists (select 1 from site_assignments sa where sa.site_id = s.id and sa.user_id = v_caller_id)
    loop
        v_check := public.compute_prosm_time_geofence_check(v_site.id, p_latitude, p_longitude, p_accuracy_meters);
        if coalesce((v_check->>'checked')::boolean, false) and coalesce((v_check->>'withinGeofence')::boolean, false) then
            id := v_site.id;
            name := v_site.name;
            display_address := v_site.display_address;
            distance_meters := (v_check->>'distanceMeters')::double precision;
            return next;
        end if;
    end loop;
end;
$function$;

revoke all on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) from public, anon;
grant execute on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) to authenticated;

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null
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
            -- § live UX review, user-directed - "I'm at a different
            -- site every day, the geofence itself should let me clock
            -- in without a prior assignment." Allowed only when the
            -- site requires geofencing and the caller is verifiably
            -- inside it right now (re-checked here server-side, never
            -- trusted from list_prosm_time_nearby_sites' own earlier
            -- suggestion) - never persists a site_assignments row,
            -- this is a one-time walk-in, not a permanent assignment.
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
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
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

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) to authenticated;

commit;
