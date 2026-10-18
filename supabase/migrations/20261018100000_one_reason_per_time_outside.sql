-- Owner 2026-10-18: "the reason request sometimes comes more than once -
-- it should come once for each time someone leaves the work area". The
-- shift's location checks only skipped a new exception while the previous
-- one was still open, so a reviewed exception was followed by a new
-- request at the next check although the person had never come back, and
-- a clock-out from outside made another one.
--
-- Each presence session now knows whether the person is outside
-- (outside_since) and when they were last inside (last_inside_at):
-- * inside -> outside opens one exception (or adopts the one the clock-in
--   just made for the same time outside);
-- * staying outside asks nothing more, whatever the review status;
-- * back inside ends it; the next time outside asks again;
-- * any other exception while the person is still outside (a clock-out
--   from there) is covered by the open one.

begin;

alter table public.presence_sessions add column if not exists outside_since timestamptz;
alter table public.presence_sessions add column if not exists last_inside_at timestamptz;

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
    v_distance_meters double precision;
    v_effective_radius_meters double precision;
    v_violation_result jsonb;
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

    -- § real gap fix, 14-point live-audit - run against prior samples
    -- BEFORE inserting this one below, so "previous" never means
    -- itself. Never blocks - see this migration's own header comment.
    perform public.check_prosm_time_location_plausibility(
        v_caller_id, v_session.organization_id, v_session.site_id, p_latitude, p_longitude, now(),
        'presence_sessions', p_presence_session_id
    );

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
        v_effective_radius_meters := v_session.radius_meters + coalesce(p_accuracy_meters, 0);
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_effective_radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters,
            'effectiveRadiusMeters', v_effective_radius_meters
        );
    end if;

    -- Owner 2026-10-18: one reason request per time outside the work area.
    -- Leaving the area (inside -> outside) opens one exception - or adopts
    -- the one the clock-in already made for this same time outside - and
    -- nothing more is asked while the person stays outside, even after a
    -- manager has reviewed it. Coming back inside ends it; only leaving
    -- again asks again.
    if coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = false then
        if v_session.outside_since is null then
            if not exists (
                select 1 from geofence_exceptions
                where user_id = v_caller_id
                  and created_at >= coalesce(v_session.last_inside_at, v_session.started_at) - interval '1 minute'
            ) then
                v_violation_result := public.handle_prosm_time_geofence_violation(
                    v_session.organization_id, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
                    p_presence_session_id => p_presence_session_id, p_site_id => v_session.site_id
                );
                v_exception_created := coalesce((v_violation_result->>'exceptionCreated')::boolean, false);
            end if;
            update presence_sessions set outside_since = now() where id = p_presence_session_id;
        end if;
    elsif coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = true then
        update presence_sessions set outside_since = null, last_inside_at = now() where id = p_presence_session_id;
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

create or replace function public.handle_prosm_time_geofence_violation(
    p_organization_id uuid,
    p_user_id uuid,
    p_distance_meters double precision,
    p_attendance_event_id uuid default null,
    p_presence_session_id uuid default null,
    p_site_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_is_owner boolean;
    v_is_supervisor boolean;
    v_exception_id uuid;
    v_subject_name text;
    v_recipient record;
    v_open_breach uuid;
begin
    -- Owner 2026-10-18: still outside since an exception was opened for
    -- this time outside (for example a clock-out from where the shift's
    -- monitoring already found the person) - the same exception covers it.
    select ge.id into v_open_breach
    from presence_sessions ps
    join geofence_exceptions ge on ge.user_id = ps.user_id and ge.created_at >= ps.outside_since - interval '1 minute'
    where ps.user_id = p_user_id and ps.status = 'active' and ps.outside_since is not null
    order by ge.created_at
    limit 1;
    if v_open_breach is not null then
        return jsonb_build_object('exceptionCreated', false, 'exceptionId', v_open_breach);
    end if;

    select is_owner into v_is_owner from users where id = p_user_id;

    insert into geofence_exceptions (organization_id, user_id, attendance_event_id, presence_session_id, distance_meters, status)
    values (p_organization_id, p_user_id, p_attendance_event_id, p_presence_session_id, p_distance_meters, 'pending_reason')
    returning id into v_exception_id;

    select full_name into v_subject_name from users where id = p_user_id;

    perform public.create_prosm_time_notification(
        p_organization_id, p_user_id, 'out_of_zone_employee', 'normal',
        'You are outside your assigned work area',
        'Please explain why. Distance: ' || round(p_distance_meters::numeric) || ' m.',
        'geofence_exceptions', v_exception_id,
        jsonb_build_object('distanceMeters', round(p_distance_meters::numeric))
    );

    -- § fix, 2026-09-15 - the Owner has no one above them to escalate
    -- to (there is no concept of a second Owner/manager over an Owner
    -- in this schema) - they've already been notified themselves
    -- above, so there's nothing further to do here for that case.
    if coalesce(v_is_owner, false) then
        return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
    end if;

    v_is_supervisor := exists (
        select 1 from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join users u on u.role_id = rdp.role_id
            where u.id = p_user_id
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = false
        ) effective
        where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
    );

    if v_is_supervisor then
        for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                p_organization_id, v_recipient.id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
                v_subject_name || ' is outside the assigned area.', 'geofence_exceptions', v_exception_id,
                jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
            );
        end loop;
    else
        perform public.notify_prosm_time_site_managers_or_owner(
            p_organization_id, p_site_id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
            v_subject_name || ' is outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
        );
    end if;

    return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
exception
    when others then
        raise exception 'HANDLE PROSM TIME GEOFENCE VIOLATION FAILED: %', sqlerrm;
end;
$function$;

commit;
