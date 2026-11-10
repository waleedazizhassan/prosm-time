-- 2026-11-10 (owner): "late today is 0 although people clocked in late". With no roster, the dashboard's
-- lateness came only from a site's "late deductions start at" time, so a site with working hours but
-- no such time never showed anyone late - while the daily summary counts lateness from the roster, else
-- the site's start time plus its grace. The dashboard's "late today" (the card and the sites table)
-- now follows the daily summary's rule too. Payroll and deductions are not touched.
-- Rollback: drop prosm_time_late_today(uuid, date) and restore the two late clauses of
-- get_prosm_time_manager_dashboard from 20261109100000.

begin;

create or replace function public.prosm_time_late_today(p_user uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with first_in as (
        select s.clock_in_at, coalesce(s.site_id, s.responsible_site_id) as site_id, s.organization_id
        from attendance_sessions s
        where s.user_id = p_user
          and s.clock_in_at >= (p_day - 1)::timestamp and s.clock_in_at < (p_day + 2)::timestamp
          and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_day
        order by s.clock_in_at
        limit 1
    ),
    planned as (
        select f.clock_in_at,
               public.prosm_time_site_timezone(f.site_id, f.organization_id) as tz,
               coalesce((select sa.start_time from shift_assignments sa where sa.user_id = p_user and sa.shift_date = p_day and sa.status = 'scheduled' order by sa.start_time limit 1),
                        st.shift_start_time) as start_time,
               coalesce(st.grace_tolerance_minutes, 0) as grace
        from first_in f left join sites st on st.id = f.site_id
    )
    select coalesce((select (p.clock_in_at at time zone p.tz)::time > p.start_time + make_interval(mins => p.grace)
                     from planned p where p.start_time is not null), false);
$$;
revoke all on function public.prosm_time_late_today(uuid, date) from public, anon, authenticated;

do $patch$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date,date,text,uuid,text)'::regprocedure);
    a1 text := 'late_today as (select user_id from today_summaries where (s ->> ''lateMinutes'')::numeric > 0)';
    a2 text := '(select count(*) from today_summaries sm where (sm.s ->> ''siteId'')::uuid = st.id and (sm.s ->> ''lateMinutes'')::numeric > 0)';
begin
    if position(a1 in v_def) = 0 then raise exception 'late_today anchor not found'; end if;
    if position(a2 in v_def) = 0 then raise exception 'site late anchor not found'; end if;
    v_def := replace(v_def, a1, 'late_today as (select user_id from today_summaries where (s ->> ''lateMinutes'')::numeric > 0 or public.prosm_time_late_today(user_id, v_today))');
    v_def := replace(v_def, a2, '(select count(*) from today_summaries sm where (sm.s ->> ''siteId'')::uuid = st.id and ((sm.s ->> ''lateMinutes'')::numeric > 0 or public.prosm_time_late_today(sm.user_id, v_today)))');
    execute v_def;
end;
$patch$;

commit;
