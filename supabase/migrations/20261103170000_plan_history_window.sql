-- 2026-11-03 (owner): a plan's history is real. Starter and Business show the last 2 years
-- of attendance records, Pro the last 5; organisations from before plans and trials see
-- everything. Records are KEPT - only what is shown and reported is limited, so an upgrade
-- brings older records straight back. (Sensitive data is a different matter and is
-- deleted: location points after 30 days, attendance photos after 90, or sooner if the
-- owner shortens it - 20261101130000, daily jobs.)
--   * reading the tables directly: a restrictive policy on each attendance table;
--   * reports and figures: their start date cannot go back past the plan's window.
-- Rollback: drop the "*_history_window" policies, remove the "p_start_date := greatest("
-- lines from the functions listed below, drop prosm_time_history_start_date(uuid), and
-- restore get_prosm_time_plan_features from 20261103140000.

begin;

-- The first day a plan shows. No limit (legacy, trial, no entitlement, history_days null) = -infinity.
create or replace function public.prosm_time_history_start_date(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select case when e.plan = 'legacy' or e.status = 'trial' or p.history_days is null then '-infinity'::date
                    else current_date - p.history_days end
        from entitlements e join plans p on p.key = e.plan
        where e.organization_id = p_org), '-infinity'::date);
$$;
revoke all on function public.prosm_time_history_start_date(uuid) from public, anon;
grant execute on function public.prosm_time_history_start_date(uuid) to authenticated;

do $$
declare
    v_pair text[];
begin
    foreach v_pair slice 1 in array array[
        ['attendance_sessions', 'clock_in_at'],
        ['attendance_events', 'occurred_at'],
        ['break_events', 'started_at'],
        ['site_worker_attendance', 'clock_in_at'],
        ['timesheets', 'period_end'],
        ['allowance_sheets', 'period_end'],
        ['allowance_entries', 'entry_date'],
        ['leave_requests', 'end_date'],
        ['attendance_day_adjustments', 'work_date']
    ] loop
        execute format('drop policy if exists %I on public.%I', v_pair[1] || '_history_window', v_pair[1]);
        -- evaluated once per query (initplan), for the caller's organisation
        execute format('create policy %I on public.%I as restrictive for select to authenticated using (%I >= (select public.prosm_time_history_start_date(public.current_prosm_time_organization_id())))',
                       v_pair[1] || '_history_window', v_pair[1], v_pair[2]);
    end loop;
end $$;

-- Reports and figures read with the server's rights: clamp their start date.
do $$
declare
    v_name text;
    v_def text;
    v_new text;
begin
    foreach v_name in array array[
        'get_prosm_time_attendance_insights', 'list_prosm_time_report_absences', 'list_prosm_time_report_labor_cost',
        'list_prosm_time_report_late', 'list_prosm_time_report_leave_conflicts', 'list_prosm_time_report_location_violations',
        'list_prosm_time_report_manager_overrides', 'list_prosm_time_report_missing_checkouts', 'list_prosm_time_report_payroll',
        'list_prosm_time_report_site_summary', 'list_prosm_time_shift_actuals', 'list_prosm_time_site_worker_attendance'
    ] loop
        for v_def in
            select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v_name and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
        loop
            continue when position('prosm_time_history_start_date' in v_def) > 0;
            v_new := regexp_replace(v_def, E'(\\n[ \\t]*begin\\M[^\\n]*\\n)',
                '\1    p_start_date := greatest(p_start_date, public.prosm_time_history_start_date(public.current_prosm_time_organization_id()));' || chr(10), 'i');
            if v_new = v_def then raise exception 'NO BEGIN FOUND IN %', v_name; end if;
            execute v_new;
        end loop;
    end loop;
end $$;

-- The app shows the window in the plan card.
create or replace function public.get_prosm_time_plan_features()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select jsonb_build_object(
            'plan', e.plan,
            'status', e.status,
            'historyDays', case when e.plan = 'legacy' or e.status = 'trial' then null else p.history_days end,
            'features', case when e.plan = 'legacy' or e.status = 'trial'
                             then (select feature_flags from plans where key = 'pro')
                             else p.feature_flags end)
        from entitlements e join plans p on p.key = e.plan
        where e.organization_id = public.current_prosm_time_organization_id()),
        jsonb_build_object('plan', 'legacy', 'status', 'active', 'historyDays', null, 'features', (select feature_flags from plans where key = 'pro')));
$$;

commit;
