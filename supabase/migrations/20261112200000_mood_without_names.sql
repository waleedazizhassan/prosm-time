-- Owner 2026-11-12: the shift rating is read without names - a person who knows the owner sees their answer
-- next to their name answers "great" every time, and the figure means nothing. The daily summary no longer
-- carries each person's answer; the ratings are read only as totals (the dashboard's card: by site, by
-- client, by day - get_prosm_time_mood_insights, unchanged).
-- Rollback: re-apply the summary patch of 20261111170000_shift_mood.sql.

begin;

do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure), chr(13) || chr(10), chr(10));
    a text := ' ''mood'', (select s.shift_mood from attendance_sessions s where s.user_id = w.user_id and s.shift_mood is not null
                 and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_date order by s.clock_out_at desc limit 1),';
begin
    if position(a in v_def) = 0 then raise exception 'summary mood anchor not found'; end if;
    v_def := replace(v_def, a, '');
    execute v_def;
end;
$patch$;

commit;
