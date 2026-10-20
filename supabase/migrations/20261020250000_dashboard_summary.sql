-- Owner 2026-10-20 ("the dashboard's numbers are not right - shorten them and
-- reprogram them"). The dashboard counted its figures in the app from about a
-- dozen separate reads; on a phone one failed read ("Failed to fetch") left
-- figures like "1 present of 0". The figures are now counted here, in one
-- read, over exactly the people the caller is responsible for:
--   team        - active people the caller sees (their sites; the Owner: all),
--                 never the Owner (the Owner does not clock in)
--   present     - of the team, with a shift open now
--   on_break    - of those present, on a break now
--   on_leave    - of the team, on approved leave today (and not present)
--   absent      - the rest of the team: not present and not on leave
--   waiting     - items the caller can decide (never their own): reasons for
--                 time outside the area, correction requests, offline time,
--                 fake locations, leave, timesheets, allowances
--   week        - worked minutes per day, Sunday to Saturday, in the caller's
--                 time zone, an open shift counted up to now

begin;

create or replace function public.get_prosm_time_dashboard_summary(p_week_start date, p_time_zone text default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_tz text := coalesce((select name from pg_timezone_names where name = p_time_zone limit 1), 'UTC');
    v_today date;
    v_result jsonb;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_user_has_permission_internal(v_caller, 'attendance.view')) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_today := (now() at time zone v_tz)::date;

    with team as (
        select u.id from users u
        where u.organization_id = v_org and u.is_active and not u.is_owner
          and public.prosm_time_caller_sees_person(u.id)
    ),
    present as (
        select distinct s.user_id from attendance_sessions s join team t on t.id = s.user_id
        where s.status = 'clocked_in'
    ),
    on_break as (
        select distinct b.user_id from break_events b join present p on p.user_id = b.user_id
        where b.status = 'active'
    ),
    on_leave as (
        select distinct l.user_id from leave_requests l join team t on t.id = l.user_id
        where l.status = 'approved' and v_today between l.start_date and l.end_date
          and l.user_id not in (select user_id from present)
    ),
    days as (
        select (p_week_start + i) as day from generate_series(0, 6) as i
    ),
    worked as (
        select (s.clock_in_at at time zone v_tz)::date as day,
               sum(extract(epoch from (coalesce(s.clock_out_at, now()) - s.clock_in_at)) / 60) as minutes
        from attendance_sessions s
        where s.organization_id = v_org
          and s.clock_in_at >= (p_week_start::timestamp at time zone v_tz)
          and s.clock_in_at < ((p_week_start + 7)::timestamp at time zone v_tz)
          and (public.current_prosm_time_user_is_owner() or public.prosm_time_caller_sees_person(s.user_id))
        group by 1
    ),
    decidable as (
        select user_id from geofence_exceptions where organization_id = v_org and status = 'pending_review'
        union all select user_id from correction_requests where organization_id = v_org and status = 'pending'
        union all select user_id from offline_time_reviews where organization_id = v_org and status = 'pending'
        union all select user_id from mock_location_flags where organization_id = v_org and status = 'pending_review'
        union all select user_id from leave_requests where organization_id = v_org and status = 'pending'
        union all select user_id from timesheets where organization_id = v_org and status = 'submitted'
        union all select user_id from allowance_entries where organization_id = v_org and status = 'submitted'
    )
    select jsonb_build_object(
        'team', (select count(*) from team),
        'present', (select count(*) from present),
        'onBreak', (select count(*) from on_break),
        'onLeave', (select count(*) from on_leave),
        'absent', greatest(0, (select count(*) from team) - (select count(*) from present) - (select count(*) from on_leave)),
        'waiting', (select count(*) from decidable d where d.user_id <> v_caller and public.prosm_time_caller_has_authority_over(d.user_id)),
        'week', (select jsonb_agg(jsonb_build_object('day', d.day, 'minutes', round(coalesce(w.minutes, 0)::numeric)) order by d.day)
                 from days d left join worked w on w.day = d.day),
        'asOf', now()
    ) into v_result;

    return v_result;
end;
$function$;

revoke all on function public.get_prosm_time_dashboard_summary(date, text) from public, anon;
grant execute on function public.get_prosm_time_dashboard_summary(date, text) to authenticated;

commit;
