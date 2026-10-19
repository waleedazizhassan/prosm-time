-- Owner 2026-10-19: clocking someone in or out on their behalf is for
-- the Owner and Managers only. Supervisors lose the two on-behalf
-- permissions from their default bundle, and the server refuses anyone
-- else even if a permission was granted individually. A Supervisor keeps
-- marking an SOS at their site as handled (now through exceptions.manage,
-- which they have, instead of the on-behalf clock-out permission).

begin;

delete from public.role_default_permissions rdp
using public.roles r, public.permissions p
where rdp.role_id = r.id and rdp.permission_id = p.id
  and r.role_key = 'supervisor'
  and p.permission_key in ('attendance.clock_in_on_behalf', 'attendance.clock_out_on_behalf');

CREATE OR REPLACE FUNCTION public.admin_clock_in_prosm_time_attendance(p_subject_user_id uuid, p_site_id uuid, p_reason text, p_project_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- Audit 4.4 - only people below the caller's own role (the Owner: anyone).
    if not (public.current_prosm_time_user_is_owner() or public.current_prosm_time_user_role_key() = 'manager') then
        raise exception 'ONLY THE OWNER OR A MANAGER MAY ACT ON SOMEONE ELSES BEHALF';
    end if;

    if not public.prosm_time_can_act_on_behalf_of(v_caller_id, p_subject_user_id) then
        raise exception 'YOU CAN ONLY ACT ON BEHALF OF PEOPLE BELOW YOUR ROLE';
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

CREATE OR REPLACE FUNCTION public.admin_clock_out_prosm_time_attendance(p_subject_user_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
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
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    -- Audit 4.4 - only people below the caller's own role (the Owner: anyone).
    if not (public.current_prosm_time_user_is_owner() or public.current_prosm_time_user_role_key() = 'manager') then
        raise exception 'ONLY THE OWNER OR A MANAGER MAY ACT ON SOMEONE ELSES BEHALF';
    end if;

    if not public.prosm_time_can_act_on_behalf_of(v_caller_id, p_subject_user_id) then
        raise exception 'YOU CAN ONLY ACT ON BEHALF OF PEOPLE BELOW YOUR ROLE';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-out-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'THIS EMPLOYEE IS NOT CURRENTLY CLOCKED IN';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        if v_open_session.site_id is null or not (v_open_session.site_id = any(public.current_prosm_time_managed_site_ids())) then
            raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
        end if;
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_open_session.id, p_subject_user_id, 'clock_out', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    -- § the actual fix - this UPDATE was missing entirely before today,
    -- the one gap between this function and the regular self-service
    -- clock_out_prosm_time_attendance, which always had it.
    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_OUT_ON_BEHALF', 'attendance_sessions', v_open_session.id,
        v_subject.full_name || ' clocked out by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('sessionId', v_open_session.id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_out', v_open_session.id, v_event_id,
        p_reason, 'clocked_in', 'clocked_out', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_prosm_time_sos_alert(p_sos_alert_id uuid, p_resolution_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    select * into v_alert from sos_alerts where id = p_sos_alert_id and organization_id = v_caller_org;
    if v_alert.id is null then
        raise exception 'SOS ALERT NOT FOUND';
    end if;
    -- An emergency: anyone in charge of the alert's site may mark it handled (no rank rule).
    if not (
        public.current_prosm_time_user_is_owner()
        or v_alert.site_id = any(public.current_prosm_time_managed_site_ids())
        or (v_alert.site_id is null and public.current_prosm_time_caller_manages_users_site(v_alert.user_id))
    ) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
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

commit;
