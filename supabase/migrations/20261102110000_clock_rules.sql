-- 2026-11-02 (plan stage 8.2): the two clock rules the policy did not have: a
-- grace for leaving early and rounding of the day's worked minutes. Both default
-- to today's behaviour (0 and 1) and follow the organisation > site > template scopes.
-- Rollback: restore the three functions from 20261025150000 and later, drop the columns.

begin;

alter table public.overtime_policies
    add column min_early_leave_minutes integer check (min_early_leave_minutes >= 0),
    add column round_minutes integer check (round_minutes between 1 and 60);

CREATE OR REPLACE FUNCTION public.prosm_time_overtime_policy(p_user_id uuid, p_site_id uuid, p_day date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with scopes as (
        select 1 as rank, p.* from overtime_policies p join users u on u.organization_id = p.organization_id
        where u.id = p_user_id and p.site_id is null and p.shift_template_id is null
        union all
        select 2, p.* from overtime_policies p where p.site_id = p_site_id
        union all
        select 3, p.* from overtime_policies p
        where p.shift_template_id in (select sa.shift_template_id from shift_assignments sa where sa.user_id = p_user_id and sa.shift_date = p_day and sa.status = 'scheduled')
    )
    select jsonb_build_object(
        'approvalMode', coalesce((select approval_mode from scopes where approval_mode is not null order by rank desc limit 1), 'approval'),
        'minOvertimeMinutes', coalesce((select min_overtime_minutes from scopes where min_overtime_minutes is not null order by rank desc limit 1), 0),
        'minLateMinutes', coalesce((select min_late_minutes from scopes where min_late_minutes is not null order by rank desc limit 1), 0),
        'minEarlyLeaveMinutes', coalesce((select min_early_leave_minutes from scopes where min_early_leave_minutes is not null order by rank desc limit 1), 0),
        'roundMinutes', coalesce((select round_minutes from scopes where round_minutes is not null order by rank desc limit 1), 1),
        'maxDailyOvertimeMinutes', (select max_daily_overtime_minutes from scopes where max_daily_overtime_minutes is not null order by rank desc limit 1),
        'multiplierNormal', coalesce((select multiplier_normal from scopes where multiplier_normal is not null order by rank desc limit 1), 1.0),
        'multiplierNight', coalesce((select multiplier_night from scopes where multiplier_night is not null order by rank desc limit 1), 1.0),
        'multiplierWeeklyRest', coalesce((select multiplier_weekly_rest from scopes where multiplier_weekly_rest is not null order by rank desc limit 1), 1.0),
        'multiplierPublicHoliday', coalesce((select multiplier_public_holiday from scopes where multiplier_public_holiday is not null order by rank desc limit 1), 1.0),
        'nightStart', coalesce((select night_start from scopes where night_start is not null order by rank desc limit 1), '22:00'::time),
        'nightEnd', coalesce((select night_end from scopes where night_end is not null order by rank desc limit 1), '06:00'::time)
    );
$function$
;

CREATE OR REPLACE FUNCTION public.set_prosm_time_overtime_policy(p_site_id uuid, p_shift_template_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before overtime_policies%rowtype;
    v_id uuid;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER SETS THE OVERTIME POLICY'; end if;
    if p_site_id is not null and p_shift_template_id is not null then raise exception 'CHOOSE ONE SCOPE'; end if;
    if p_site_id is not null and not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;
    if p_shift_template_id is not null and not exists (select 1 from shift_templates where id = p_shift_template_id and organization_id = v_org) then raise exception 'SHIFT TEMPLATE NOT FOUND'; end if;
    if (p_policy ->> 'approvalMode') is not null and p_policy ->> 'approvalMode' not in ('automatic', 'approval') then raise exception 'INVALID OVERTIME POLICY'; end if;

    select * into v_before from overtime_policies
    where organization_id = v_org and site_id is not distinct from p_site_id and shift_template_id is not distinct from p_shift_template_id;
    if v_before.id is null then
        insert into overtime_policies (organization_id, site_id, shift_template_id) values (v_org, p_site_id, p_shift_template_id) returning id into v_id;
    else
        v_id := v_before.id;
    end if;
    begin
        update overtime_policies set
            approval_mode = p_policy ->> 'approvalMode',
            min_overtime_minutes = (p_policy ->> 'minOvertimeMinutes')::integer,
            min_late_minutes = (p_policy ->> 'minLateMinutes')::integer,
            -- an older app does not send these two: what is stored stays
            min_early_leave_minutes = case when p_policy ? 'minEarlyLeaveMinutes' then (p_policy ->> 'minEarlyLeaveMinutes')::integer else min_early_leave_minutes end,
            round_minutes = case when p_policy ? 'roundMinutes' then (p_policy ->> 'roundMinutes')::integer else round_minutes end,
            max_daily_overtime_minutes = (p_policy ->> 'maxDailyOvertimeMinutes')::integer,
            multiplier_normal = (p_policy ->> 'multiplierNormal')::numeric,
            multiplier_night = (p_policy ->> 'multiplierNight')::numeric,
            multiplier_weekly_rest = (p_policy ->> 'multiplierWeeklyRest')::numeric,
            multiplier_public_holiday = (p_policy ->> 'multiplierPublicHoliday')::numeric,
            night_start = (p_policy ->> 'nightStart')::time,
            night_end = (p_policy ->> 'nightEnd')::time,
            updated_by = public.current_prosm_time_user_id(), updated_at = now()
        where id = v_id;
    exception when check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
        raise exception 'INVALID OVERTIME POLICY';
    end;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state, context)
    values (v_org, public.current_prosm_time_user_id(), 'settings.overtime_policy', 'overtime_policies', v_id, 'Overtime policy changed',
            case when v_before.id is null then null else to_jsonb(v_before) end, p_policy,
            jsonb_build_object('siteId', p_site_id, 'shiftTemplateId', p_shift_template_id));
    return jsonb_build_object('success', true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prosm_time_day_summary(p_user_id uuid, p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_org uuid;
    v_site uuid;
    v_tz text;
    v_first_in timestamptz;
    v_last_out timestamptz;
    v_sessions integer;
    v_worked numeric := 0;
    v_breaks numeric := 0;
    v_unpaid_breaks numeric := 0;
    v_day_type text;
    v_exception jsonb;
    v_policy jsonb;
    v_assignment shift_assignments%rowtype;
    v_template shift_templates%rowtype;
    v_site_row sites%rowtype;
    v_start time;
    v_end time;
    v_overtime_from timestamptz;
    v_raw_overtime numeric := 0;
    v_night_overtime numeric := 0;
    v_overtime numeric := 0;
    v_late numeric := 0;
    v_early numeric := 0;
    v_deduction numeric := 0;
    v_overtime_approved boolean := false;
    v_overtime_pending numeric := 0;
    v_no_overtime boolean := false;
    v_multiplier numeric;
    v_weighted numeric;
    v_adjust attendance_day_adjustments%rowtype;
    v_permission record;
    v_permissions jsonb := '[]'::jsonb;
    v_night_from timestamptz;
    v_night_to timestamptz;
begin
    select organization_id into v_org from users where id = p_user_id;

    select coalesce(ats.site_id, ats.responsible_site_id) into v_site
    from attendance_sessions ats
    where ats.user_id = p_user_id and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
    order by ats.clock_in_at limit 1;
    v_tz := public.prosm_time_site_timezone(v_site, v_org);

    select count(*), min(ats.clock_in_at), max(ats.clock_out_at), coalesce(sum(extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60), 0)
    into v_sessions, v_first_in, v_last_out, v_worked
    from attendance_sessions ats
    where ats.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);

    v_day_type := public.prosm_time_day_type(p_user_id, v_site, p_day);
    v_exception := public.prosm_time_day_exception(p_user_id, v_site, p_day);
    v_policy := public.prosm_time_overtime_policy(p_user_id, v_site, p_day);
    select * into v_assignment from shift_assignments where user_id = p_user_id and shift_date = p_day and status = 'scheduled' order by start_time limit 1;
    if v_assignment.shift_template_id is not null then select * into v_template from shift_templates where id = v_assignment.shift_template_id; end if;
    select * into v_site_row from sites where id = v_site;

    -- d) breaks: unpaid breaks come off the worked time; no break at all on a
    -- template with an automatic deduction takes that deduction.
    select coalesce(sum(extract(epoch from (coalesce(b.ended_at, ats.clock_out_at) - b.started_at)) / 60), 0),
           coalesce(sum(case when not b.paid or v_template.break_paid = false then extract(epoch from (coalesce(b.ended_at, ats.clock_out_at) - b.started_at)) / 60 else 0 end), 0)
    into v_breaks, v_unpaid_breaks
    from break_events b join attendance_sessions ats on ats.id = b.attendance_session_id
    where b.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);
    if v_template.id is not null and v_template.break_max_minutes is not null and v_template.break_paid then
        v_unpaid_breaks := v_unpaid_breaks + greatest(v_breaks - v_template.break_max_minutes, 0);
    end if;
    if v_worked > 0 and v_breaks = 0 and v_template.break_auto_deduct_minutes is not null then
        v_unpaid_breaks := v_unpaid_breaks + v_template.break_auto_deduct_minutes;
    end if;
    v_worked := greatest(v_worked - v_unpaid_breaks, 0);
    -- the day's worked time, rounded to the organisation's step (1 = as it is)
    if (v_policy ->> 'roundMinutes')::integer > 1 then
        v_worked := round(v_worked / (v_policy ->> 'roundMinutes')::integer) * (v_policy ->> 'roundMinutes')::integer;
    end if;

    -- the day's hours: exceptional day > the person's shift > the site
    v_start := coalesce((v_exception ->> 'start_time')::time,
                        case when v_assignment.id is not null then v_assignment.start_time + make_interval(mins => coalesce(v_site_row.grace_tolerance_minutes, 0)) end,
                        v_site_row.late_deduction_start_time);
    v_end := coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.shift_end_time);

    if v_worked > 0 then
        if v_day_type in ('weekly_rest', 'public_holiday') then
            v_raw_overtime := v_worked;
        else
            v_overtime_from := case
                when coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.overtime_start_time) is null then null
                else (p_day + coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.overtime_start_time)) at time zone v_tz
                     + case when v_assignment.id is not null and v_assignment.end_time < v_assignment.start_time and (v_exception ->> 'end_time') is null then interval '1 day' else interval '0' end
            end;
            if v_overtime_from is not null then
                select coalesce(sum(greatest(extract(epoch from (ats.clock_out_at - greatest(ats.clock_in_at, v_overtime_from))) / 60, 0)), 0)
                into v_raw_overtime
                from attendance_sessions ats
                where ats.user_id = p_user_id
                  and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
                  and public.prosm_time_session_counts(ats.status, ats.hours_review_status);
                v_raw_overtime := least(v_raw_overtime, v_worked);
            end if;
            if v_start is not null and v_first_in is not null then
                v_late := greatest(extract(epoch from (v_first_in - ((p_day + v_start) at time zone v_tz))) / 60, 0);
            end if;
            if v_end is not null and v_last_out is not null then
                v_early := greatest(extract(epoch from ((((p_day + v_end) at time zone v_tz)
                           + case when v_assignment.id is not null and v_assignment.end_time < v_assignment.start_time and (v_exception ->> 'end_time') is null then interval '1 day' else interval '0' end)
                           - v_last_out)) / 60, 0);
            end if;
        end if;
    end if;

    -- b) thresholds and the daily cap
    if v_raw_overtime < (v_policy ->> 'minOvertimeMinutes')::numeric then v_raw_overtime := 0; end if;
    if v_late <= (v_policy ->> 'minLateMinutes')::numeric then v_late := 0; end if;
    if v_early <= (v_policy ->> 'minEarlyLeaveMinutes')::numeric then v_early := 0; end if;
    if (v_policy ->> 'maxDailyOvertimeMinutes') is not null then
        v_raw_overtime := least(v_raw_overtime, (v_policy ->> 'maxDailyOvertimeMinutes')::numeric);
    end if;

    -- a) permissions in force
    for v_permission in
        select * from attendance_permissions where user_id = p_user_id and work_date = p_day and status = 'approved' order by created_at
    loop
        v_permissions := v_permissions || jsonb_build_object('id', v_permission.id, 'kind', v_permission.kind, 'paid', v_permission.paid,
                                                             'minutes', v_permission.minutes, 'reason', v_permission.reason);
        if v_permission.kind = 'late_arrival' then
            v_late := case
                when v_permission.paid then 0
                when v_permission.deduction_minutes is not null then least(v_late, v_permission.deduction_minutes)
                else v_late * coalesce(v_permission.deduction_percent, 0) / 100
            end;
        elsif v_permission.kind = 'early_leave' then
            v_early := case
                when v_permission.paid then 0
                when v_permission.deduction_minutes is not null then least(v_early, v_permission.deduction_minutes)
                else v_early * coalesce(v_permission.deduction_percent, 0) / 100
            end;
        elsif v_permission.kind = 'approved_overtime' then
            v_overtime_approved := true;
            if v_permission.minutes is not null then v_raw_overtime := least(v_raw_overtime, v_permission.minutes); end if;
        elsif v_permission.kind = 'no_overtime' then
            v_no_overtime := true;
        end if;
    end loop;

    -- e) the manager's adjustment in force (the latest)
    select * into v_adjust from attendance_day_adjustments where user_id = p_user_id and work_date = p_day order by created_at desc limit 1;
    if v_adjust.id is not null then
        if v_adjust.overtime_approved is not null then v_overtime_approved := v_adjust.overtime_approved; end if;
        if v_adjust.overtime_minutes is not null then v_raw_overtime := v_adjust.overtime_minutes; v_overtime_approved := coalesce(v_adjust.overtime_approved, true); end if;
        if v_adjust.late_minutes is not null then v_late := v_adjust.late_minutes; end if;
    end if;

    if v_no_overtime then
        v_overtime := 0;
    elsif v_policy ->> 'approvalMode' = 'automatic' or v_overtime_approved then
        v_overtime := v_raw_overtime;
    else
        v_overtime := 0;
        v_overtime_pending := v_raw_overtime;
    end if;

    -- c) multipliers: rest day / holiday, otherwise normal with the night part
    if v_overtime > 0 then
        if v_day_type = 'weekly_rest' then
            v_weighted := v_overtime * (v_policy ->> 'multiplierWeeklyRest')::numeric;
        elsif v_day_type = 'public_holiday' then
            v_weighted := v_overtime * (v_policy ->> 'multiplierPublicHoliday')::numeric;
        else
            v_night_from := (p_day + (v_policy ->> 'nightStart')::time) at time zone v_tz;
            v_night_to := ((p_day + case when (v_policy ->> 'nightEnd')::time <= (v_policy ->> 'nightStart')::time then 1 else 0 end) + (v_policy ->> 'nightEnd')::time) at time zone v_tz;
            if v_overtime_from is not null and v_last_out is not null then
                v_night_overtime := least(greatest(extract(epoch from (least(v_last_out, v_night_to) - greatest(v_overtime_from, v_night_from))) / 60, 0), v_overtime);
            end if;
            v_weighted := (v_overtime - v_night_overtime) * (v_policy ->> 'multiplierNormal')::numeric
                        + v_night_overtime * (v_policy ->> 'multiplierNight')::numeric;
        end if;
    else
        v_weighted := 0;
    end if;

    if v_day_type in ('weekly_rest', 'public_holiday') or coalesce((v_exception ->> 'no_deduction')::boolean, false) then
        v_late := 0;
        v_early := 0;
    end if;
    v_deduction := v_late + v_early;
    if v_adjust.id is not null and v_adjust.deduction_minutes is not null then v_deduction := v_adjust.deduction_minutes; end if;

    return jsonb_build_object(
        'day', p_day, 'siteId', v_site, 'dayType', v_day_type, 'sessions', v_sessions,
        'firstIn', v_first_in, 'lastOut', v_last_out,
        'workedMinutes', v_worked, 'breakMinutes', v_breaks, 'unpaidBreakMinutes', v_unpaid_breaks,
        'overtimeMinutes', v_overtime, 'overtimeWeightedMinutes', v_weighted, 'nightOvertimeMinutes', v_night_overtime,
        'overtimePendingApprovalMinutes', v_overtime_pending,
        'lateMinutes', v_late, 'earlyLeaveMinutes', v_early, 'deductionMinutes', v_deduction,
        'noDeduction', coalesce((v_exception ->> 'no_deduction')::boolean, false),
        'permissions', v_permissions, 'adjusted', v_adjust.id is not null,
        'approvalMode', v_policy ->> 'approvalMode'
    );
end;
$function$
;

commit;
