-- Audit 2026-10-12, item 4.4 - a supervisor could clock their own
-- manager in or out on their behalf: the on-behalf functions checked the
-- permission and the organisation, not who the subject was. Now a caller
-- may act only for people below their own role (manager > supervisor >
-- employee / read-only); the Owner may act for anyone. The People list
-- for Clock In/Out On Behalf shows the same people.

begin;

create or replace function public.prosm_time_role_rank(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $function$
    select case
        when u.is_owner then 4
        when r.role_key = 'manager' then 3
        when r.role_key = 'supervisor' then 2
        else 1
    end
    from users u
    left join roles r on r.id = u.role_id
    where u.id = p_user_id;
$function$;

create or replace function public.prosm_time_can_act_on_behalf_of(p_caller_id uuid, p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(
        (select is_owner from users where id = p_caller_id)
        or public.prosm_time_role_rank(p_subject_id) < public.prosm_time_role_rank(p_caller_id),
        false
    );
$function$;

revoke execute on function public.prosm_time_role_rank(uuid) from public, anon, authenticated;
revoke execute on function public.prosm_time_can_act_on_behalf_of(uuid, uuid) from public, anon, authenticated;

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

    -- Audit 4.4 - only people below the caller's own role (the Owner: anyone).
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

create or replace function public.admin_clock_out_prosm_time_attendance(
    p_subject_user_id uuid,
    p_reason text,
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

commit;
