-- PROSM Time - 3 real gaps from live user testing.
--
-- 1. admin_clock_in_prosm_time_attendance required the subject to have
--    a real site_assignments row at the target site, with no Owner
--    exception - the Owner should be able to record attendance for
--    ANY org member, not be constrained the same way a scoped manager
--    is (mirrors the Owner-bypass convention used everywhere else in
--    this schema, e.g. current_prosm_time_managed_site_ids() callers).
--
-- 2. list_prosm_time_kiosk_roster only ever listed that one site's own
--    site_assignments - for the Owner specifically, every active org
--    member should appear at any kiosk, not just that site's assigned
--    crew.
--
-- 3. set_prosm_time_kiosk_pin already existed (self-service, the
--    caller sets their own PIN) but had zero frontend callers anywhere
--    in src/ - no UI ever exposed it. admin_set_prosm_time_kiosk_pin
--    also existed and was equally unused. Per the user's explicit
--    direction ("the kiosk PIN must be chosen by the employee
--    themselves, not a manager or the Owner"), only the self-service
--    RPC gets a real UI (UserMenu.tsx) - admin_set_prosm_time_kiosk_pin
--    is left as-is (unused, not wired to anything, not removed either
--    since it's real existing schema, not this change's concern).

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

    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    -- § user-directed, 2026-09-12 - the Owner records on behalf of
    -- anyone in the organization, unconstrained by a formal site
    -- assignment; a scoped manager/supervisor still needs the subject
    -- to actually be assigned to the target site.
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

create or replace function public.list_prosm_time_kiosk_roster(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_roster jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;

    if v_site.kiosk_mode not in ('kiosk_only', 'both_allowed') then
        raise exception 'KIOSK MODE IS NOT ENABLED FOR THIS SITE';
    end if;

    if public.current_prosm_time_user_is_owner() then
        -- § user-directed, 2026-09-12 - the Owner sees every active
        -- member of the organization at any kiosk, not just this
        -- specific site's own assigned crew.
        select coalesce(jsonb_agg(jsonb_build_object('userId', u.id, 'fullName', u.full_name) order by u.full_name), '[]'::jsonb)
        into v_roster
        from users u
        where u.organization_id = v_caller_org and u.status = 'active';
    else
        select coalesce(jsonb_agg(jsonb_build_object('userId', u.id, 'fullName', u.full_name) order by u.full_name), '[]'::jsonb)
        into v_roster
        from site_assignments sa
        join users u on u.id = sa.user_id
        where sa.site_id = p_site_id and u.status = 'active';
    end if;

    return jsonb_build_object('success', true, 'roster', v_roster);
exception
    when others then
        raise exception 'LIST PROSM TIME KIOSK ROSTER FAILED: %', sqlerrm;
end;
$function$;

commit;
