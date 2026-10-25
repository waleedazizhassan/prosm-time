-- PROSM Time v2.3.43, step 10 (item 9): a manager (or the Owner) clocking
-- someone in or out on their behalf can set the TIME (within the last 7
-- days, not in the future; a clock-out after the clock-in; no overlap with a
-- recorded shift) and write the PLACE NAME when there is no registered site
-- (attendance_sessions.manual_location_label). The reason stays required;
-- the site's self-service blocks never apply (item 10). The audit keeps the
-- time set and the time it was recorded; the managerOverrides report lists
-- it as before. Otherwise the same as the effective definitions.

begin;

alter table public.attendance_events drop constraint if exists attendance_events_time_source_check;
alter table public.attendance_events add constraint attendance_events_time_source_check
    check (time_source in ('server', 'device_offline', 'auto_closed', 'auto_geofence', 'admin_set'));

drop function if exists public.admin_clock_in_prosm_time_attendance(uuid, uuid, text, uuid, text, double precision, double precision, double precision, text);
drop function if exists public.admin_clock_out_prosm_time_attendance(uuid, text, text, double precision, double precision, double precision, text);

CREATE FUNCTION public.admin_clock_in_prosm_time_attendance(p_subject_user_id uuid, p_site_id uuid, p_reason text, p_project_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_manual_location_label text DEFAULT NULL::text)
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
    v_at timestamptz := coalesce(p_occurred_at, now());
    v_label text := nullif(trim(coalesce(p_manual_location_label, '')), '');
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
    -- Step 10 (item 9): the time the manager sets (now by default), within the last 7 days.
    if v_at > now() + interval '1 minute' or v_at < now() - interval '7 days' then
        raise exception 'THE TIME MUST BE WITHIN THE LAST 7 DAYS AND NOT IN THE FUTURE';
    end if;
    if exists (
        select 1 from attendance_sessions
        where user_id = p_subject_user_id and status = 'clocked_out' and clock_out_at > v_at
    ) then
        raise exception 'THIS TIME OVERLAPS A RECORDED SHIFT';
    end if;

    if exists (
        select 1 from leave_requests
        where user_id = p_subject_user_id
          and status = 'approved'
          and (v_at at time zone public.prosm_time_site_timezone(p_site_id, v_caller_org))::date between start_date and end_date
    ) then
        raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE TODAY';
    end if;

    -- Step 10 (item 9): no registered site - a place name the manager writes.
    if p_site_id is null then
        if v_label is null then raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED'; end if;
        if not public.prosm_time_caller_has_authority_over(p_subject_user_id) then
            raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
        end if;
    elsif not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    -- Workflow audit C3 (owner 2026-10-20): a manager acts only at a site they manage.
    if p_site_id is not null and not public.prosm_time_caller_has_authority_over(p_subject_user_id, p_site_id) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    if p_site_id is not null and not public.current_prosm_time_user_is_owner() and not exists (
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

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, p_subject_user_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', v_at,
            case when p_site_id is null then v_label else null end)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by, time_source, note
    ) values (
        v_session_id, p_subject_user_id, 'clock_in', v_at, p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id,
        case when p_occurred_at is null then 'server' else 'admin_set' end, v_label
    )
    returning id into v_event_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_IN_ON_BEHALF', 'attendance_sessions', v_session_id,
        v_subject.full_name || ' clocked in by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('siteId', p_site_id, 'projectId', p_project_id, 'manualLocationLabel', v_label,
                                     'occurredAt', v_at, 'recordedAt', now(), 'timeSetByManager', p_occurred_at is not null)
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

CREATE FUNCTION public.admin_clock_out_prosm_time_attendance(p_subject_user_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_manual_location_label text DEFAULT NULL::text)
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
    v_at timestamptz := coalesce(p_occurred_at, now());
    v_label text := nullif(trim(coalesce(p_manual_location_label, '')), '');
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

    -- Workflow audit M3 (owner 2026-10-20): a shift clocked in away from
    -- every site is judged by the site responsible for it, or - with no
    -- site at all - by the caller's authority over the person.
    if not public.prosm_time_caller_has_authority_over(p_subject_user_id, coalesce(v_open_session.site_id, v_open_session.responsible_site_id)) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;

    -- Step 10 (item 9): the time the manager sets (now by default), after the clock-in.
    if v_at > now() + interval '1 minute' or v_at <= v_open_session.clock_in_at then
        raise exception 'THE CLOCK-OUT TIME MUST BE AFTER THE CLOCK-IN AND NOT IN THE FUTURE';
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by, time_source, note
    ) values (
        v_open_session.id, p_subject_user_id, 'clock_out', v_at, p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id,
        case when p_occurred_at is null then 'server' else 'admin_set' end, v_label
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = v_at, updated_at = now() where id = v_open_session.id;

    -- § the actual fix - this UPDATE was missing entirely before today,
    -- the one gap between this function and the regular self-service
    -- clock_out_prosm_time_attendance, which always had it.
    update presence_sessions
    set status = 'ended', ended_at = v_at, end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_OUT_ON_BEHALF', 'attendance_sessions', v_open_session.id,
        v_subject.full_name || ' clocked out by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('sessionId', v_open_session.id, 'manualLocationLabel', v_label,
                                     'occurredAt', v_at, 'recordedAt', now(), 'timeSetByManager', p_occurred_at is not null)
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

revoke all on function public.admin_clock_in_prosm_time_attendance(uuid, uuid, text, uuid, text, double precision, double precision, double precision, text, timestamptz, text) from public, anon;
revoke all on function public.admin_clock_out_prosm_time_attendance(uuid, text, text, double precision, double precision, double precision, text, timestamptz, text) from public, anon;
grant execute on function public.admin_clock_in_prosm_time_attendance(uuid, uuid, text, uuid, text, double precision, double precision, double precision, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.admin_clock_out_prosm_time_attendance(uuid, text, text, double precision, double precision, double precision, text, timestamptz, text) to authenticated, service_role;

commit;
