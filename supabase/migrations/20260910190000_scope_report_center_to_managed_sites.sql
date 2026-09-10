-- PROSM Time - Manager permissions/visibility technical audit,
-- user-directed ("صلاحيات المديرين وشاشتهم لازم تتراجع بطريقة تقنية").
--
-- Real gap found: 20260902090000 established a deliberate, consistent
-- convention across this whole schema - a Manager's 'attendance.view'/
-- 'exceptions.manage' authority is scoped to current_prosm_time_
-- managed_site_ids() (the sites where they hold site_assignments.
-- role_at_site = 'manager'), not the whole organization. Every existing
-- attendance-adjacent table's SELECT RLS, and both on-behalf clock-in/
-- out RPCs, follow this. The Owner always keeps unscoped visibility.
--
-- The 7 new Reports Center RPCs added today (20260910180000) missed
-- this convention entirely - each only checked org membership +
-- 'attendance.view', with no site filter at all. A Manager who manages
-- only one site could pull Site/Late/Missing-Checkout/Leave-Conflict/
-- Manager-Override/Location-Violations reports covering every OTHER
-- site in the organization too. This migration adds the same scoping
-- these functions' own siblings already use, changing no signatures or
-- return shapes (safe to CREATE OR REPLACE, not a column-set change).
--
-- Workforce and Manager-Override have no direct per-row site_id column
-- to filter on - scoped via their own real relationships instead:
-- Workforce via site_assignments (only employees assigned to one of
-- the caller's managed sites); Manager-Override via the underlying
-- attendance_sessions.site_id (employee on-behalf actions, reached
-- through admin_on_behalf_actions) or site_worker_attendance.site_id
-- (the site-worker override action added today).

begin;

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
    v_is_owner boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    v_is_owner := public.current_prosm_time_user_is_owner();

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
      and (
          v_is_owner
          or u.id = v_caller_id
          or exists (
              select 1 from site_assignments sa2
              where sa2.user_id = u.id
              and sa2.site_id = any(public.current_prosm_time_managed_site_ids())
          )
      )
    group by u.id, u.full_name, u.email, r.name, u.is_owner, u.status, u.created_at
    order by u.full_name;
end;
$function$;

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
    left join attendance_events ae on ae.session_id = sess.id
    left join geofence_exceptions ge on ge.attendance_event_id = ae.id
        and ge.created_at::date between p_start_date and p_end_date
    where s.organization_id = v_org
      and (public.current_prosm_time_user_is_owner() or s.id = any(public.current_prosm_time_managed_site_ids()))
    group by s.id, s.name
    order by s.name;
end;
$function$;

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
      and (public.current_prosm_time_user_is_owner() or s.id = any(public.current_prosm_time_managed_site_ids()))
    order by sess.clock_in_at desc;
end;
$function$;

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
      and (
          public.current_prosm_time_user_is_owner()
          -- A no-site (GPS-only) session has nothing to scope against -
          -- same posture as admin_clock_out_prosm_time_attendance
          -- (Owner-only for those); excluded from a Manager's report.
          or sess.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by sess.clock_in_at desc;
end;
$function$;

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
      and (
          public.current_prosm_time_user_is_owner()
          or sess.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by sess.clock_in_at desc;
end;
$function$;

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
    left join admin_on_behalf_actions aoba on aoba.audit_log_id = al.id
    left join attendance_sessions sess on sess.id = aoba.session_id
    left join site_worker_attendance swa on al.action = 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF' and swa.id = al.entity_id
    where al.organization_id = v_org
      and al.action in ('ADMIN_CLOCK_IN_ON_BEHALF', 'ADMIN_CLOCK_OUT_ON_BEHALF', 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF')
      and al.created_at::date between p_start_date and p_end_date
      and (
          public.current_prosm_time_user_is_owner()
          or sess.site_id = any(public.current_prosm_time_managed_site_ids())
          or swa.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by al.created_at desc;
end;
$function$;

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
      and (
          public.current_prosm_time_user_is_owner()
          or lpf.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by lpf.occurred_at desc;
end;
$function$;

commit;
