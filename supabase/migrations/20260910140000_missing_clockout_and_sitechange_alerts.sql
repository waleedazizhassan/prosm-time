-- PROSM Time - two real gaps found in the 14-point live-audit:
--
-- 1. site_change_events (mid-shift location moves) was write/read-only
--    - nothing ever alerted a site manager that someone moved into or
--      out of their site mid-shift. change_prosm_time_site now raises
--      a real notification, reusing notify_prosm_time_site_managers_
--      or_owner (20260904130000) exactly the way geofence violations
--      already do - same body sent to the old site's manager(s) (if
--      any), the new site's manager(s) (if any), and the Owner always
--      (create_prosm_time_notification's own 15-minute dedup collapses
--      the Owner's second call for free since the body is identical).
--
-- 2. An abandoned/missing-checkout session had zero proactive
--    detection - list_prosm_time_missing_clock_outs (20260901110000)
--    was real, working, service_role-only, and never actually called
--    by anything. Adds notify_prosm_time_missing_clock_outs(), the
--    same site-scoped notification, and schedules it via pg_cron every
--    6 hours (the default 12-hour threshold means a session is flagged
--    well within the same day, without paging a manager hourly for a
--    session that's still legitimately open).
begin;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review',
    'correction_submitted', 'correction_reviewed', 'break_exceeded', 'sos_alert',
    'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected',
    'shift_assigned', 'site_change_alert', 'missing_clock_out'
));

-- ===== 1. site_change_events alerting =====

create or replace function public.change_prosm_time_site(
    p_break_id uuid default null,
    p_new_site_id uuid default null,
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
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

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
        v_exceeded := coalesce(extract(epoch from (now() - v_break.started_at)) / 60 > v_old_site.break_max_duration_minutes, false);
        update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;
    end if;

    update attendance_sessions
    set site_id = p_new_site_id, project_id = null, manual_location_label = case when p_new_site_id is null then v_manual_label else null end
    where id = v_session.id;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters, manual_location_label)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters, v_manual_label)
    returning id into v_change_id;

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

-- ===== 2. Proactive missing-clock-out detection =====

create or replace function public.notify_prosm_time_missing_clock_outs(p_hours_since_clock_in integer default 12)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row record;
    v_count integer := 0;
begin
    for v_row in
        select s.id as session_id, s.user_id, s.organization_id, s.site_id, s.clock_in_at, u.full_name
        from attendance_sessions s
        join users u on u.id = s.user_id
        where s.status = 'clocked_in' and s.clock_in_at < now() - (p_hours_since_clock_in || ' hours')::interval
    loop
        perform public.notify_prosm_time_site_managers_or_owner(
            v_row.organization_id, v_row.site_id, 'missing_clock_out', 'normal', 'Employee has not clocked out',
            v_row.full_name || ' has been clocked in since ' || to_char(v_row.clock_in_at, 'YYYY-MM-DD HH24:MI') || ' with no clock-out yet.',
            'attendance_sessions', v_row.session_id,
            jsonb_build_object('employeeName', v_row.full_name, 'clockInAt', v_row.clock_in_at, 'hoursSinceClockIn', p_hours_since_clock_in)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$function$;

revoke all on function public.notify_prosm_time_missing_clock_outs(integer) from public, anon, authenticated;
grant execute on function public.notify_prosm_time_missing_clock_outs(integer) to service_role, postgres;

create extension if not exists pg_cron;

do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'prosm-time-missing-clockout-check';
exception
    when undefined_table then null;
end $$;

select cron.schedule(
    'prosm-time-missing-clockout-check',
    '0 */6 * * *',
    $$select public.notify_prosm_time_missing_clock_outs();$$
);

commit;
