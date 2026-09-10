-- PROSM Time - 14-point live-audit gap #8: the Reports Center
-- (src/modules/reports/ReportsPage.tsx) only had 3 real report types
-- (attendance/allowances/timesheets). The user's own spec named 8 more:
-- Workforce, Contractor, Site, Late, Missing-Checkout, Leave-Conflict,
-- Manager-Override, Location-Violations.
--
-- Contractor already has a real, working data source
-- (list_prosm_time_worker_attendance_export, 20260910100000) - just
-- needed wiring into the UI, done in the same frontend commit as this
-- migration. The 7 RPCs below cover the rest, each a real query over
-- data this session has already built (audit_logs for overrides,
-- location_plausibility_flags for violations, leave_requests joined
-- against real attendance, sites' own real shift/grace policy for
-- lateness) - none of them invent new tracking, all of them report on
-- what the app already records.
begin;

-- Workforce: the real employee roster, one row per active user, with
-- their current site assignment (a user can be assigned to more than
-- one site - string_agg keeps this to one row per employee for a
-- report, rather than a row per assignment).
create or replace function public.list_prosm_time_report_workforce()
returns table (
    user_id uuid,
    full_name text,
    email text,
    role_name text,
    is_owner boolean,
    site_names text,
    status text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();

    return query
    select
        u.id, u.full_name, u.email, coalesce(r.name, ''), u.is_owner,
        coalesce(string_agg(distinct s.name, ', ' order by s.name), ''),
        u.status, u.created_at
    from users u
    left join roles r on r.id = u.role_id
    left join site_assignments sa on sa.user_id = u.id
    left join sites s on s.id = sa.site_id
    where u.organization_id = v_org
    group by u.id, u.full_name, u.email, r.name, u.is_owner, u.status, u.created_at
    order by u.full_name;
end;
$function$;

-- Site summary: headcount (distinct employees with any attendance in
-- range) and total worked hours per site, in the given date range.
create or replace function public.list_prosm_time_report_site_summary(p_start_date date, p_end_date date)
returns table (
    site_id uuid,
    site_name text,
    employee_count bigint,
    total_hours numeric,
    exception_count bigint
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        s.id, s.name,
        count(distinct sess.user_id),
        round(coalesce(sum(extract(epoch from (coalesce(sess.clock_out_at, now()) - sess.clock_in_at))) / 3600.0, 0)::numeric, 1),
        count(distinct ge.id)
    from sites s
    left join attendance_sessions sess on sess.site_id = s.id
        and sess.clock_in_at::date between p_start_date and p_end_date
    -- geofence_exceptions has no direct site_id - it hangs off the
    -- attendance_event, which hangs off the session, which has one.
    left join attendance_events ae on ae.session_id = sess.id
    left join geofence_exceptions ge on ge.attendance_event_id = ae.id
        and ge.created_at::date between p_start_date and p_end_date
    where s.organization_id = v_org
    group by s.id, s.name
    order by s.name;
end;
$function$;

-- Late: real clock-ins measured against the site's own real shift
-- policy (shift_start_time + grace_tolerance_minutes, site-local time -
-- the exact same rule already enforced live at clock-in time, WP-09/
-- 20260902130000 - this just reports on it after the fact). Sites with
-- no shift policy configured have no "late" concept and are excluded,
-- not silently reported as always-on-time.
create or replace function public.list_prosm_time_report_late(p_start_date date, p_end_date date)
returns table (
    session_id uuid,
    user_full_name text,
    site_name text,
    shift_start_time time,
    clock_in_at timestamptz,
    minutes_late integer
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        sess.id, u.full_name, s.name, s.shift_start_time, sess.clock_in_at,
        extract(epoch from (
            (sess.clock_in_at at time zone coalesce(s.timezone, 'UTC'))::time - s.shift_start_time
        ))::integer / 60 - coalesce(s.grace_tolerance_minutes, 0)
    from attendance_sessions sess
    join users u on u.id = sess.user_id
    join sites s on s.id = sess.site_id
    where sess.organization_id = v_org
      and s.shift_start_time is not null
      and sess.clock_in_at::date between p_start_date and p_end_date
      and (sess.clock_in_at at time zone coalesce(s.timezone, 'UTC'))::time
          > (s.shift_start_time + make_interval(mins => coalesce(s.grace_tolerance_minutes, 0)))
    order by sess.clock_in_at desc;
end;
$function$;

-- Missing-checkout: sessions this org's employees left open well past
-- a real workday (>12h, matching the existing scheduled reminder job's
-- own threshold - list_prosm_time_missing_clock_outs, 20260901110000)
-- within the report's date range. That function is service_role-only
-- and org-agnostic (built for a cross-org cron sweep) - this is the
-- org-scoped, permission-checked equivalent for a report a real user
-- can actually call.
create or replace function public.list_prosm_time_report_missing_checkouts(p_start_date date, p_end_date date)
returns table (
    session_id uuid,
    user_full_name text,
    site_name text,
    clock_in_at timestamptz,
    hours_open numeric,
    still_open boolean
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        sess.id, u.full_name, coalesce(s.name, sess.manual_location_label, '-'),
        sess.clock_in_at,
        round((extract(epoch from (coalesce(sess.clock_out_at, now()) - sess.clock_in_at)) / 3600.0)::numeric, 1),
        sess.status = 'clocked_in'
    from attendance_sessions sess
    join users u on u.id = sess.user_id
    left join sites s on s.id = sess.site_id
    where sess.organization_id = v_org
      and sess.clock_in_at::date between p_start_date and p_end_date
      and coalesce(sess.clock_out_at, now()) - sess.clock_in_at > interval '12 hours'
    order by sess.clock_in_at desc;
end;
$function$;

-- Leave-conflict: real attendance sessions whose clock-in date falls
-- inside an approved leave request for the same user. clock_in_prosm_
-- time_attendance (20260910160000) blocks this going forward, but a
-- manager can still request the historical record - e.g. sessions from
-- before that fix shipped, or an admin-on-behalf clock-in bypassing the
-- self-service check (admin_clock_in_prosm_time_attendance has no
-- equivalent block - an authorized override, not a gap this report
-- exists to catch retroactively).
create or replace function public.list_prosm_time_report_leave_conflicts(p_start_date date, p_end_date date)
returns table (
    session_id uuid,
    user_full_name text,
    site_name text,
    clock_in_at timestamptz,
    leave_type text,
    leave_start_date date,
    leave_end_date date
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        sess.id, u.full_name, coalesce(s.name, sess.manual_location_label, '-'),
        sess.clock_in_at, lr.leave_type, lr.start_date, lr.end_date
    from attendance_sessions sess
    join users u on u.id = sess.user_id
    left join sites s on s.id = sess.site_id
    join leave_requests lr on lr.user_id = sess.user_id
        and lr.status = 'approved'
        and sess.clock_in_at::date between lr.start_date and lr.end_date
    where sess.organization_id = v_org
      and sess.clock_in_at::date between p_start_date and p_end_date
    order by sess.clock_in_at desc;
end;
$function$;

-- Manager-override: every admin-on-behalf action already logged in
-- audit_logs (employee clock-in/out, this pass's own site-worker
-- clock-out override) - a real, already-populated data source, just
-- never surfaced in the Reports Center.
create or replace function public.list_prosm_time_report_manager_overrides(p_start_date date, p_end_date date)
returns table (
    audit_log_id uuid,
    actor_name text,
    subject_name text,
    action text,
    description text,
    reason text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        al.id, coalesce(actor.full_name, '-'), coalesce(subject.full_name, '-'),
        al.action, al.description, al.reason, al.created_at
    from audit_logs al
    left join users actor on actor.id = al.actor_user_id
    left join users subject on subject.id = al.subject_user_id
    where al.organization_id = v_org
      and al.action in ('ADMIN_CLOCK_IN_ON_BEHALF', 'ADMIN_CLOCK_OUT_ON_BEHALF', 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF')
      and al.created_at::date between p_start_date and p_end_date
    order by al.created_at desc;
end;
$function$;

-- Location-violations: the GPS speed-plausibility flags from this
-- pass's own anti-fraud check (20260910160000), a real already-
-- populated data source.
create or replace function public.list_prosm_time_report_location_violations(p_start_date date, p_end_date date)
returns table (
    flag_id uuid,
    user_full_name text,
    site_name text,
    implied_speed_kmh double precision,
    distance_meters double precision,
    occurred_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        lpf.id, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
        lpf.implied_speed_kmh, lpf.distance_meters, lpf.occurred_at
    from location_plausibility_flags lpf
    join users u on u.id = lpf.user_id
    left join sites s on s.id = lpf.site_id
    where lpf.organization_id = v_org
      and lpf.occurred_at::date between p_start_date and p_end_date
    order by lpf.occurred_at desc;
end;
$function$;

grant execute on function public.list_prosm_time_report_workforce() to authenticated;
grant execute on function public.list_prosm_time_report_site_summary(date, date) to authenticated;
grant execute on function public.list_prosm_time_report_late(date, date) to authenticated;
grant execute on function public.list_prosm_time_report_missing_checkouts(date, date) to authenticated;
grant execute on function public.list_prosm_time_report_leave_conflicts(date, date) to authenticated;
grant execute on function public.list_prosm_time_report_manager_overrides(date, date) to authenticated;
grant execute on function public.list_prosm_time_report_location_violations(date, date) to authenticated;

commit;
