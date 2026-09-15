-- PROSM Time - user-reported real gap (2026-09-15): "الموظف يقدر
-- يسجل حضور او حد يسجله من خلال الكشك او بالانابة وهو مسجل اجازة" -
-- an employee on approved leave can still be clocked in via the kiosk
-- or an admin/Owner on-behalf action, even though self clock-in was
-- already blocked for this exact case (20260910110000). That earlier
-- migration deliberately excluded admin_clock_in_prosm_time_attendance,
-- reasoning it was already a real, audited override path (mandatory
-- reason, admin_on_behalf_actions row) - the user has now reported
-- that as a real problem, not an intended exception, so this closes
-- both remaining gaps the same way: a hard block, matching self
-- clock-in's own behavior exactly. If a manager genuinely needs to
-- override (e.g. leave was granted in error), the correct path is to
-- reject/cancel the leave request first through the existing Leave
-- management flow, not to silently clock someone in while their leave
-- still shows approved.
--
-- kiosk_clock_in_prosm_time_attendance had ZERO leave awareness at
-- all (no reason, no audit trail beyond the normal clock-in event) -
-- the most clear-cut gap of the two, since a kiosk PIN tap carries no
-- manager judgment behind it whatsoever.

begin;

create or replace function public.admin_clock_in_prosm_time_attendance(
    p_subject_user_id uuid,
    p_site_id uuid,
    p_reason text,
    p_project_id uuid default null,
    p_idempotency_key text default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_device_info text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_idempotency_key text;
    v_audit_log_id uuid;
    v_action_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_in_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_IN_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-in-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    -- § real gap fix, user-reported 2026-09-15 - same block as self
    -- clock-in (20260910110000). Placed after the idempotency-replay
    -- check for the same reason: a replay of an already-succeeded
    -- clock-in must still succeed.
    if exists (
        select 1 from leave_requests
        where user_id = p_subject_user_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE TODAY';
    end if;

    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    if not public.current_prosm_time_user_is_owner() and not exists (
        select 1 from site_assignments where site_id = p_site_id and user_id = p_subject_user_id
    ) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = p_subject_user_id) then
            raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'THIS EMPLOYEE IS ALREADY CLOCKED IN';
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, p_subject_user_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_session_id, p_subject_user_id, 'clock_in', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_IN_ON_BEHALF', 'attendance_sessions', v_session_id,
        v_subject.full_name || ' clocked in by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('siteId', p_site_id, 'projectId', p_project_id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_in', v_session_id, v_event_id,
        p_reason, 'not_clocked_in', 'clocked_in', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.kiosk_clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_employee_user_id uuid,
    p_pin text,
    p_idempotency_key text,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_employee users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_exception_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_employee from users where id = p_employee_user_id;
    if v_employee.id is null or v_employee.organization_id <> v_caller_org then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    -- § real gap fix, user-reported 2026-09-15 - kiosk clock-in had NO
    -- leave awareness at all (unlike self clock-in, fixed 2026-09-10).
    -- Same block, placed after the idempotency-replay check for the
    -- same reason as every other clock-in path in this codebase.
    if exists (
        select 1 from leave_requests
        where user_id = p_employee_user_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE TODAY';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if v_site.kiosk_mode not in ('kiosk_only', 'both_allowed') then
        raise exception 'KIOSK MODE IS NOT ENABLED FOR THIS SITE';
    end if;
    if not v_site.attendance_allowed then
        raise exception 'ATTENDANCE IS NOT ALLOWED AT THIS SITE';
    end if;

    if v_employee.kiosk_pin_hash is null then
        raise exception 'THIS EMPLOYEE HAS NOT SET UP A KIOSK PIN';
    end if;
    if extensions.crypt(p_pin, v_employee.kiosk_pin_hash) <> v_employee.kiosk_pin_hash then
        raise exception 'INCORRECT PIN';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = p_employee_user_id) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = p_employee_user_id) then
            raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_employee_user_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'THIS EMPLOYEE IS ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, v_site.latitude, v_site.longitude, 0);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, p_employee_user_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, source
    ) values (
        v_session_id, p_employee_user_id, 'clock_in', now(), p_client_reported_at,
        v_site.latitude, v_site.longitude, 0, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        'kiosk'
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, p_employee_user_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, p_employee_user_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            v_employee.full_name || ' clocked in outside the assigned area (kiosk).',
            'geofence_exceptions', v_exception_id
        );
    end if;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false, 'geofence', v_geofence);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'KIOSK CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'KIOSK CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

commit;
