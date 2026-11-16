-- Release check 2026-11-16: list_prosm_time_permission_queue took 2-2.6 s alone for a small organisation and timed
-- out under load - its overtime part works out a full day summary for every finished shift of the last 62 days.
-- Lighter, same answers for what can still be decided:
--   * a day inside an approved / locked timesheet is skipped (its overtime can no longer be decided - the decision
--     refuses it: prosm_time_require_day_open);
--   * the window is 35 days (a payroll month and a margin) instead of 62.
-- Known limit (documented): the cost still grows with the number of shifts in the window; storing pending overtime
-- per day is the follow-up for large organisations.
-- Rollback: re-run list_prosm_time_permission_queue as left by 20261117120000.
begin;
do $$
declare
    v_def text;
    v_old text := $q$where ats.organization_id = v_org and ats.status = 'clocked_out' and ats.clock_in_at > now() - interval '62 days'$q$;
    v_new text := $q$where ats.organization_id = v_org and ats.status = 'clocked_out' and ats.clock_in_at > now() - interval '35 days'$q$;
    v_old2 text := $q$                  and not exists (select 1 from allowance_entries e where e.user_id = d.user_id and e.entry_date = d.day and e.status = 'approved')$q$;
    v_new2 text := $q$                  and not exists (select 1 from allowance_entries e where e.user_id = d.user_id and e.entry_date = d.day and e.status = 'approved')
                  and not exists (select 1 from timesheets ts where ts.user_id = d.user_id and ts.status in ('approved', 'locked') and d.day between ts.period_start and ts.period_end)$q$;
begin
    v_def := replace(pg_get_functiondef('public.list_prosm_time_permission_queue()'::regprocedure), chr(13) || chr(10), chr(10));
    if position(v_new in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 or position(v_old2 in v_def) = 0 then raise exception 'permission queue: anchor not found'; end if;
    execute replace(replace(v_def, v_old, v_new), v_old2, v_new2);
end $$;
commit;
