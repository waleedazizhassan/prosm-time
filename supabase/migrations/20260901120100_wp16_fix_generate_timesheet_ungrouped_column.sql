-- Fix: generate_prosm_time_timesheet's period-aggregation query failed
-- live testing with "subquery uses ungrouped column ats.clock_in_at
-- from outer query" - the two correlated subqueries inside the
-- `daily` CTE's SELECT list (unpaid break minutes, site threshold)
-- referenced ats.clock_in_at::date, which Postgres does not treat as
-- equivalent to the GROUP BY expression once inside a correlated
-- subquery. Restructured into three independently-grouped CTEs joined
-- on work_date instead - same formula, no correlated reference to an
-- outer grouped column. Never edit the already-applied WP-16 migration
-- file itself; this WP-13/WP-12-style follow-up recreates only the one
-- function.
create or replace function public.generate_prosm_time_timesheet(
    p_user_id uuid,
    p_period_start date,
    p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_exceptions_count integer := 0;
    v_corrections_count integer := 0;
    v_timesheet_id uuid;
    v_existing_status text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_period_end < p_period_start then raise exception 'PERIOD END MUST NOT BE BEFORE PERIOD START'; end if;

    select organization_id into v_org_id from users where id = p_user_id;
    if v_org_id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_org_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE';
    end if;

    select id, status into v_timesheet_id, v_existing_status
    from timesheets where user_id = p_user_id and period_start = p_period_start and period_end = p_period_end;

    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    with worked_by_day as (
        select
            ats.clock_in_at::date as work_date,
            sum(extract(epoch from (coalesce(ats.clock_out_at, now()) - ats.clock_in_at)) / 60) as worked_minutes
        from attendance_sessions ats
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
        group by ats.clock_in_at::date
    ),
    unpaid_breaks_by_day as (
        select
            ats.clock_in_at::date as work_date,
            sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60) as unpaid_break_minutes
        from break_events be
        join attendance_sessions ats on ats.id = be.attendance_session_id
        where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end and be.paid = false
        group by ats.clock_in_at::date
    ),
    threshold_by_day as (
        select distinct on (ats.clock_in_at::date)
            ats.clock_in_at::date as work_date,
            s.daily_overtime_threshold_minutes as site_threshold
        from attendance_sessions ats
        join sites s on s.id = ats.site_id
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
        order by ats.clock_in_at::date, ats.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(greatest(w.worked_minutes - coalesce(ub.unpaid_break_minutes, 0) - coalesce(t.site_threshold, v_org_threshold, 480), 0)), 0)
    into v_worked_minutes, v_overtime_minutes
    from worked_by_day w
    left join unpaid_breaks_by_day ub on ub.work_date = w.work_date
    left join threshold_by_day t on t.work_date = w.work_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;
