-- Owner 2026-11-13 (Ratomag): leave given Thursday to Saturday counts one day (Friday and Saturday are the
-- organisation's rest days), yet on Friday the dashboard showed the person as "on leave today". Leave only
-- takes working days (20261108110000), so "on leave today" now follows the same calendar: a person is on
-- leave on a day only when that day is a working day of their own calendar (not a weekly rest day, a public
-- holiday or a day off). On those days they are neither on leave nor absent.
-- Applies to: the manager dashboard (count and list), the overview card, and the daily summary.
-- Rollback: re-run the three function bodies from before this migration (pg_get_functiondef), drop
-- prosm_time_on_leave_day.

begin;

create or replace function public.prosm_time_on_leave_day(p_user uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from public.prosm_time_leave_days(p_user, p_day, p_day) d where d.day_type = 'workday');
$$;
revoke all on function public.prosm_time_on_leave_day(uuid, date) from public, anon, authenticated;

do $$
declare
    v_def text;
    v_old text;
    v_n integer;
begin
    -- the manager dashboard: the "on leave today" count and the list of who is on leave
    v_def := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date, date, text, uuid, text)'::regprocedure);
    v_old := 'l.user_id = any(v_team) and l.status = ''approved'' and v_today between l.start_date and l.end_date';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 2 then raise exception 'manager dashboard: expected 2 leave anchors, found %', v_n; end if;
    execute replace(v_def, v_old, v_old || ' and public.prosm_time_on_leave_day(l.user_id, v_today)');

    -- the overview card
    v_def := pg_get_functiondef('public.get_prosm_time_dashboard_summary(date, text)'::regprocedure);
    v_old := 'where l.status = ''approved'' and v_today between l.start_date and l.end_date';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then raise exception 'dashboard summary: expected 1 leave anchor, found %', v_n; end if;
    execute replace(v_def, v_old, v_old || ' and public.prosm_time_on_leave_day(l.user_id, v_today)');

    -- the daily summary
    v_def := pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure);
    v_old := 'lr.status = ''approved'' and p_date between lr.start_date and lr.end_date';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then raise exception 'daily summary: expected 1 leave anchor, found %', v_n; end if;
    execute replace(v_def, v_old, v_old || ' and public.prosm_time_on_leave_day(lr.user_id, p_date)');
end $$;

commit;
