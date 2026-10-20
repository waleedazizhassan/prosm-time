-- Owner 2026-10-20 (where does a timesheet go?):
-- 1. Generating a timesheet now tells the employee it is ready to review and
--    submit - before, nothing told them, so it waited unseen.
-- 2. A submitted timesheet (or a correction request on an approved one) is
--    notified to the Owner and the managers of the employee's site who rank
--    above them - the people who can approve it - instead of every
--    timesheets.approve holder in the organisation.

begin;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready']));

create or replace function public.notify_prosm_time_timesheet_approvers(
    p_organization_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_approver record;
    v_subject uuid;
begin
    if p_related_entity_type in ('timesheets', 'timesheet') then
        select user_id into v_subject from timesheets where id = p_related_entity_id;
    elsif p_related_entity_type in ('timesheet_corrections', 'timesheet_correction') then
        select ts.user_id into v_subject from timesheet_corrections tc join timesheets ts on ts.id = tc.timesheet_id where tc.id = p_related_entity_id;
    end if;

    for v_approver in
        select u.id from users u
        where u.organization_id = p_organization_id
          and u.is_active
          and public.prosm_time_user_has_permission_internal(u.id, 'timesheets.approve')
          and (
              u.is_owner
              or v_subject is null
              or (
                  u.id <> v_subject
                  and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_subject)
                  and exists (
                      select 1 from site_assignments msa
                      join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = v_subject
                      where msa.user_id = u.id and msa.role_at_site = 'manager'
                  )
              )
          )
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_approver.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
    end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_deduction_minutes double precision := 0;
    v_leave_days numeric := 0;
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
            or (
                'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over(p_user_id)
            )
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

    -- Approved leave overlapping this period, calendar-day-inclusive
    -- overlap (matches leave_requests.days_count's own "end - start + 1"
    -- convention) rather than the leave's own full days_count, since a
    -- single leave request can span across a period boundary.
    select coalesce(sum(
        least(lr.end_date, p_period_end) - greatest(lr.start_date, p_period_start) + 1
    ), 0)
    into v_leave_days
    from leave_requests lr
    where lr.user_id = p_user_id
      and lr.status = 'approved'
      and lr.start_date <= p_period_end
      and lr.end_date >= p_period_start;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes, total_leave_days,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes, v_leave_days,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
        total_leave_days = excluded.total_leave_days,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    -- Owner 2026-10-20: the next step is the employee's - tell them it's ready.
    if p_user_id <> v_caller_id then
        perform public.create_prosm_time_notification(
            v_org_id, p_user_id, 'timesheet_ready', 'normal', 'Your timesheet is ready',
            'Review your timesheet for ' || p_period_start || ' - ' || p_period_end || ' and submit it.',
            'timesheets', v_timesheet_id,
            jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end)
        );
    end if;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

commit;
