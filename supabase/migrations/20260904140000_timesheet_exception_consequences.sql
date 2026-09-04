-- PROSM Time - live UX review, user-directed: a manager reviewing a
-- geofence exception was purely cosmetic - approving or rejecting only
-- ever updated geofence_exceptions.status, nothing downstream (the
-- timesheet) ever read that decision. User's own words, translated:
-- "if the manager approves, the employee is treated as if they were
-- present the full time with no violation at all; if the manager
-- rejects - at either step, before or after the employee's own
-- explanation - the employee is deducted from that point, and their
-- effective clock-out is calculated from the FIRST detected event."
--
-- Approve needs no new code (full time is already what happens today
-- when nothing overrides it). Reject now caps that session's worked
-- time at the EARLIEST rejected exception's own detected-at timestamp
-- (geofence_exceptions.created_at - the same "when" for a clock-in/
-- out-time violation and a mid-shift one) instead of the real
-- clock_out_at. "Rejected" is determined by looking at the LATEST
-- exception_actions row for that exception (a later approval on
-- re-review correctly overturns an earlier rejection).
--
-- Also fixes the overtime/break inconsistency the same review flagged:
-- user's own words - "break time is never deducted from working
-- hours; overtime is calculated from the hour the manager sets in the
-- site's own settings." The overtime_start_time branch already did
-- this correctly; the fallback (duration-threshold) branch was
-- wrongly subtracting unpaid break minutes first - removed, and the
-- now-unused unpaid_breaks_by_day CTE with it.

begin;

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
    v_deduction_minutes double precision := 0;
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

    with rejected_exception_cap as (
        -- The earliest violation, per session, whose MOST RECENT
        -- review decision was a rejection (a later approval on
        -- re-review correctly lifts an earlier rejection's cap).
        select
            coalesce(ae.session_id, ps.attendance_session_id) as session_id,
            min(ge.created_at) as cap_at
        from geofence_exceptions ge
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        where ge.user_id = p_user_id
        and exists (
            select 1 from exception_actions ea
            where ea.geofence_exception_id = ge.id
            and ea.action_type = 'rejected'
            and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
        )
        group by coalesce(ae.session_id, ps.attendance_session_id)
    ),
    capped_sessions as (
        select
            ats.id as session_id,
            ats.clock_in_at,
            ats.site_id,
            least(coalesce(ats.clock_out_at, now()), coalesce(rec.cap_at, coalesce(ats.clock_out_at, now()))) as effective_clock_out_at
        from attendance_sessions ats
        left join rejected_exception_cap rec on rec.session_id = ats.id
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
    ),
    worked_by_day as (
        select
            cs.clock_in_at::date as work_date,
            sum(extract(epoch from (cs.effective_clock_out_at - cs.clock_in_at)) / 60) as worked_minutes
        from capped_sessions cs
        group by cs.clock_in_at::date
    ),
    threshold_by_day as (
        select distinct on (cs.clock_in_at::date)
            cs.clock_in_at::date as work_date,
            s.daily_overtime_threshold_minutes as site_threshold,
            s.overtime_start_time,
            s.late_deduction_start_time,
            s.timezone as site_timezone,
            cs.clock_in_at as rep_clock_in_at,
            cs.effective_clock_out_at as rep_clock_out_at
        from capped_sessions cs
        join sites s on s.id = cs.site_id
        order by cs.clock_in_at::date, cs.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(
            case
                when t.overtime_start_time is not null and t.rep_clock_out_at is not null then
                    greatest(extract(epoch from ((t.rep_clock_out_at at time zone t.site_timezone)::time - t.overtime_start_time)) / 60, 0)
                else
                    greatest(w.worked_minutes - coalesce(t.site_threshold, v_org_threshold, 480), 0)
            end
        ), 0),
        coalesce(sum(
            case
                when t.late_deduction_start_time is not null then
                    greatest(extract(epoch from ((t.rep_clock_in_at at time zone t.site_timezone)::time - t.late_deduction_start_time)) / 60, 0)
                else 0
            end
        ), 0)
    into v_worked_minutes, v_overtime_minutes, v_deduction_minutes
    from worked_by_day w
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
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
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

commit;
