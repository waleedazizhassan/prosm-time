-- PROSM Time - two real, user-reported gaps (2026-09-08 live UX review).
--
-- 1. "زرار الطوارئ... لما حد يدوس عليه توصل الاستغاثة على مستوى كل
--    المستخدمين داخل الموقع حتى الموظفين الاخريين مش المدير والاونر
--    بس" - an SOS/Emergency alert only ever reached the org's own
--    supervisors (notify_prosm_time_supervisors - Owner/Admin or
--    exceptions.manage/attendance.clock_out_on_behalf holders,
--    confirmed live in SosAlertOverlay.tsx's own header comment). The
--    co-workers physically standing at the exact same site right now -
--    who could actually reach the person in trouble before any remote
--    Admin/Owner ever could - never got anything. trigger_prosm_time_sos_alert
--    (current/live definition: 20260903120000_localize_notifications.sql)
--    now ALSO notifies every other user currently clocked in at the
--    same site, in addition to (not instead of) the existing supervisor
--    broadcast. The supervisor set is excluded from this second loop
--    (same effective-permission check inlined, matching
--    notify_prosm_time_supervisors' own current definition -
--    20260903130000) so nobody gets the alert twice.
--
-- 2. "لما الموظف بيتمم تسجيل خروج المفروض يظهرله شاشة فيها عدد ساعات
--    العمل، مدة الراحة، عدد ساعات العمل الاضافية، ولو مشي بدري يطلعله
--    خانة يكتب فيها ليه" - no real clock-out summary existed at all;
--    "early leave" (clocking out before the site's own shift_end_time)
--    had no concept anywhere in the schema. Adds the two columns this
--    needs plus a real summary RPC (mirrors generate_prosm_time_timesheet's
--    own overtime formula - 20260902130000 - applied to a single
--    session instead of a pay period) and a reason-submission RPC that
--    notifies supervisors exactly like submit_prosm_time_exception_reason
--    already does for out-of-zone reasons.

begin;

-- ============================================================
-- 1. SOS co-worker broadcast
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
    v_caller_name text;
    v_site_name text;
    v_coworker record;
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

    select full_name into v_caller_name from users where id = v_caller_id;

    perform public.notify_prosm_time_supervisors(
        v_caller_org, 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name)
    );

    if v_session.site_id is not null then
        select name into v_site_name from sites where id = v_session.site_id;

        for v_coworker in
            select distinct ats.user_id as id
            from attendance_sessions ats
            join users u on u.id = ats.user_id
            where ats.site_id = v_session.site_id
              and ats.status = 'clocked_in'
              and ats.user_id <> v_caller_id
              and u.organization_id = v_caller_org
              and not (
                  u.is_owner
                  or exists (
                      select 1 from (
                          select p.permission_key
                          from role_default_permissions rdp
                          join permissions p on p.id = rdp.permission_id
                          where rdp.role_id = u.role_id
                          union
                          select p.permission_key
                          from user_permission_overrides upo
                          join permissions p on p.id = upo.permission_id
                          where upo.user_id = u.id and upo.is_granted = true
                          except
                          select p.permission_key
                          from user_permission_overrides upo
                          join permissions p on p.id = upo.permission_id
                          where upo.user_id = u.id and upo.is_granted = false
                      ) effective
                      where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
                  )
              )
        loop
            perform public.create_prosm_time_notification(
                v_caller_org, v_coworker.id, 'sos_alert', 'high', 'SOS/Emergency alert',
                v_caller_name || ' triggered an SOS/Emergency alert at ' || coalesce(v_site_name, 'your site') || '.',
                'sos_alerts', v_alert_id,
                jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
            );
        end loop;
    end if;

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- 2. Early leave + clock-out summary
-- ============================================================

alter table public.attendance_sessions
    add column if not exists early_leave_reason text,
    add column if not exists early_leave_reason_submitted_at timestamptz;

create or replace function public.get_prosm_time_session_summary(
    p_attendance_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_exceptions_count integer := 0;
    v_left_early boolean := false;
    v_early_minutes double precision := 0;
    v_local_clock_out time;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.user_id <> v_caller_id then raise exception 'YOU ARE NOT THE SUBJECT OF THIS SESSION'; end if;

    select organization_id into v_caller_org from users where id = v_caller_id;
    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_caller_org;

    if v_session.site_id is not null then
        select * into v_site from sites where id = v_session.site_id;
    end if;

    v_worked_minutes := extract(epoch from (coalesce(v_session.clock_out_at, now()) - v_session.clock_in_at)) / 60;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    where be.attendance_session_id = p_attendance_session_id;

    if v_site.overtime_start_time is not null and v_session.clock_out_at is not null then
        v_overtime_minutes := greatest(extract(epoch from ((v_session.clock_out_at at time zone coalesce(v_site.timezone, 'UTC'))::time - v_site.overtime_start_time)) / 60, 0);
    else
        v_overtime_minutes := greatest(v_worked_minutes - v_break_minutes - coalesce(v_site.daily_overtime_threshold_minutes, v_org_threshold, 480), 0);
    end if;

    if v_site.shift_end_time is not null and v_session.clock_out_at is not null then
        v_local_clock_out := (v_session.clock_out_at at time zone coalesce(v_site.timezone, 'UTC'))::time;
        if v_local_clock_out < v_site.shift_end_time then
            v_left_early := true;
            v_early_minutes := extract(epoch from (v_site.shift_end_time - v_local_clock_out)) / 60;
        end if;
    end if;

    select count(*) into v_exceptions_count
    from geofence_exceptions ge
    join attendance_events ae on ae.id = ge.attendance_event_id
    where ae.session_id = p_attendance_session_id;

    return jsonb_build_object(
        'workedMinutes', round(v_worked_minutes::numeric, 1),
        'breakMinutes', round(v_break_minutes::numeric, 1),
        'overtimeMinutes', round(v_overtime_minutes::numeric, 1),
        'exceptionsCount', v_exceptions_count,
        'leftEarly', v_left_early,
        'earlyMinutes', round(v_early_minutes::numeric, 1),
        'shiftEndTime', v_site.shift_end_time,
        'earlyLeaveReason', v_session.early_leave_reason
    );
exception
    when others then
        raise exception 'GET PROSM TIME SESSION SUMMARY FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.submit_prosm_time_early_leave_reason(
    p_attendance_session_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_name text;
    v_session attendance_sessions%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.user_id <> v_caller_id then raise exception 'YOU ARE NOT THE SUBJECT OF THIS SESSION'; end if;
    if v_session.status <> 'clocked_out' then raise exception 'THIS SESSION IS NOT CLOCKED OUT YET'; end if;

    update attendance_sessions
    set early_leave_reason = trim(p_reason), early_leave_reason_submitted_at = now()
    where id = p_attendance_session_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_session.organization_id, 'exception_pending_review', 'normal', 'Early leave reason submitted',
        v_caller_name || ' explained why they left early.',
        'attendance_sessions', p_attendance_session_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'early_leave')
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME EARLY LEAVE REASON FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.get_prosm_time_session_summary(uuid) from public, anon;
revoke execute on function public.submit_prosm_time_early_leave_reason(uuid, text) from public, anon;

commit;
