-- Screens review 2026-11-12: the manager's dashboard timed out on a phone ("canceling statement due to statement
-- timeout"). The day's figures (prosm_time_day_summary, behind the dashboard, timesheets, payroll and reports)
-- read every attendance record the person ever had, four times, to find the ones of that day - so every screen
-- slowed down as the history grew. They now read only the records that began around the day (a day either
-- side covers every time zone); the figures are the same. An index on the person and the time serves it.
-- Rollback: restore prosm_time_day_summary from pg_get_functiondef before this migration (the four
-- "clock_in_at >= ..." conditions removed); drop index attendance_sessions_user_clock_in_idx.

begin;

create index if not exists attendance_sessions_user_clock_in_idx on public.attendance_sessions (user_id, clock_in_at);

do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_day_summary(uuid, date)'::regprocedure);
    v_new text;
    v_old_cond text := 'public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day';
begin
    v_new := replace(v_def, v_old_cond,
        'ats.clock_in_at >= ((p_day - 1)::timestamp at time zone ''UTC'') and ats.clock_in_at < ((p_day + 2)::timestamp at time zone ''UTC'') and ' || v_old_cond);
    if (length(v_def) - length(replace(v_def, v_old_cond, ''))) / length(v_old_cond) <> 4 then
        raise exception 'prosm_time_day_summary: expected the day condition four times';
    end if;
    execute v_new;
end $$;

commit;
