-- 2026-11-02 (docs/IDEAS.md 1, 2, 3, 4, 7, 8): early warnings and figures for managers.
--   * a scheduled shift nobody clocked in for, past its grace: the site's managers and the owner hear;
--   * a person about to pass their shift's end, still clocked in: their managers hear before overtime;
--   * one morning summary of yesterday for the owner, instead of many messages;
--   * attendance rate and the people often late or on overtime, for the dashboard;
--   * what a site's roster will cost before it is worked;
--   * a budget per project, against what its labour has cost.
-- Rollback: drop the cron job, the functions, manager_alert_log, the two project columns,
-- and restore the notification type check from 20261102150000.

begin;

create table public.manager_alert_log (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    kind text not null check (kind in ('no_show', 'overtime_soon', 'daily_digest')),
    ref_id uuid not null,
    sent_at timestamptz not null default now(),
    unique (kind, ref_id)
);
alter table public.manager_alert_log enable row level security;
revoke all on public.manager_alert_log from anon, authenticated;

alter table public.projects add column budget_amount numeric check (budget_amount is null or budget_amount >= 0);

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected', 'long_session_check', 'session_auto_closed',
    'exit_site_prompt', 'auto_checkout_geofence', 'clock_in_reminder', 'clock_out_reminder', 'license_ending',
    'new_device_login', 'shift_no_show', 'overtime_soon', 'daily_digest'
]::text[]));

-- Who hears about a site: its managers and the organisation's owners.
create or replace function public.prosm_time_site_alert_recipients(p_org uuid, p_site uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    select u.id from users u where u.organization_id = p_org and u.is_owner and u.is_active
    union
    select u.id from site_assignments sa join users u on u.id = sa.user_id
    where sa.site_id = p_site and sa.role_at_site = 'manager' and u.is_active and u.organization_id = p_org;
$$;
revoke all on function public.prosm_time_site_alert_recipients(uuid, uuid) from public, anon, authenticated;

create or replace function public.process_prosm_time_manager_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row record;
    v_to uuid;
    v_no_show integer := 0;
    v_overtime integer := 0;
    v_digest integer := 0;
    v_ref uuid;
    v_yesterday date;
begin
    -- 1. No-shows: the shift began, the grace passed (15 minutes at least), nobody clocked in.
    for v_row in
        select sa.id, sa.organization_id, sa.user_id, sa.site_id, sa.start_time, s.name as site_name, u.full_name,
               ((sa.shift_date + sa.start_time) at time zone public.prosm_time_site_timezone(sa.site_id, sa.organization_id)) as starts_at,
               greatest(coalesce(s.grace_tolerance_minutes, 0), 15) as grace
        from shift_assignments sa
        join sites s on s.id = sa.site_id
        join users u on u.id = sa.user_id
        where sa.status = 'scheduled' and u.is_active and not u.is_owner
          and sa.shift_date between current_date - 1 and current_date + 1
          and not public.prosm_time_org_locked(sa.organization_id)
    loop
        continue when not (now() >= v_row.starts_at + make_interval(mins => v_row.grace) and now() < v_row.starts_at + interval '3 hours');
        continue when exists (select 1 from manager_alert_log l where l.kind = 'no_show' and l.ref_id = v_row.id);
        continue when exists (
            select 1 from attendance_sessions a
            where a.user_id = v_row.user_id and (a.status = 'clocked_in' or a.clock_in_at >= v_row.starts_at - interval '3 hours')
        );
        continue when exists (
            select 1 from leave_requests lr
            where lr.user_id = v_row.user_id and lr.status = 'approved'
              and (v_row.starts_at at time zone public.prosm_time_site_timezone(v_row.site_id, v_row.organization_id))::date between lr.start_date and lr.end_date
        );
        insert into manager_alert_log (organization_id, kind, ref_id) values (v_row.organization_id, 'no_show', v_row.id) on conflict do nothing;
        for v_to in select public.prosm_time_site_alert_recipients(v_row.organization_id, v_row.site_id) loop
            perform public.create_prosm_time_notification(
                v_row.organization_id, v_to, 'shift_no_show', 'high', 'Not clocked in for a shift',
                v_row.full_name || ' has not clocked in for the ' || to_char(v_row.start_time, 'HH24:MI') || ' shift at ' || v_row.site_name || '.',
                'shift_assignments', v_row.id,
                jsonb_build_object('name', v_row.full_name, 'time', to_char(v_row.start_time, 'HH24:MI'), 'siteName', v_row.site_name)
            );
        end loop;
        v_no_show := v_no_show + 1;
    end loop;

    -- 2. Overtime soon: still clocked in, 30 minutes before the shift (or the site's day) ends.
    for v_row in
        select a.id, a.organization_id, a.user_id, a.site_id, a.clock_in_at, u.full_name,
               coalesce(sa.end_time, s.shift_end_time) as end_time,
               public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) as work_date,
               public.prosm_time_site_timezone(a.site_id, a.organization_id) as tz
        from attendance_sessions a
        join users u on u.id = a.user_id
        left join sites s on s.id = a.site_id
        left join lateral (
            select x.end_time from shift_assignments x
            where x.user_id = a.user_id and x.status = 'scheduled'
              and x.shift_date = public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id)
            order by x.start_time limit 1
        ) sa on true
        where a.status = 'clocked_in' and u.is_active and not u.is_owner and a.site_id is not null
          and not public.prosm_time_org_locked(a.organization_id)
    loop
        continue when v_row.end_time is null;
        continue when exists (select 1 from manager_alert_log l where l.kind = 'overtime_soon' and l.ref_id = v_row.id);
        declare
            v_end timestamptz := (v_row.work_date + v_row.end_time) at time zone v_row.tz;
        begin
            if v_end <= v_row.clock_in_at then v_end := v_end + interval '1 day'; end if;
            continue when not (now() >= v_end - interval '30 minutes' and now() < v_end);
            insert into manager_alert_log (organization_id, kind, ref_id) values (v_row.organization_id, 'overtime_soon', v_row.id) on conflict do nothing;
            for v_to in select public.prosm_time_site_alert_recipients(v_row.organization_id, v_row.site_id) loop
                continue when v_to = v_row.user_id;
                perform public.create_prosm_time_notification(
                    v_row.organization_id, v_to, 'overtime_soon', 'normal', 'Overtime soon',
                    v_row.full_name || ' is still clocked in; overtime starts at ' || to_char(v_row.end_time, 'HH24:MI') || '.',
                    'attendance_sessions', v_row.id,
                    jsonb_build_object('name', v_row.full_name, 'time', to_char(v_row.end_time, 'HH24:MI'))
                );
            end loop;
            v_overtime := v_overtime + 1;
        end;
    end loop;

    -- 3. The owner's morning summary of yesterday, at 7 local time.
    for v_row in
        select o.id as organization_id, public.prosm_time_site_timezone(null, o.id) as tz
        from organizations o
        where not public.prosm_time_org_locked(o.id)
          and exists (select 1 from users u where u.organization_id = o.id and not u.is_owner and u.is_active)
    loop
        continue when extract(hour from (now() at time zone v_row.tz)) <> 7;
        v_yesterday := (now() at time zone v_row.tz)::date - 1;
        v_ref := md5(v_row.organization_id::text || v_yesterday::text)::uuid;
        continue when exists (select 1 from manager_alert_log l where l.kind = 'daily_digest' and l.ref_id = v_ref);
        insert into manager_alert_log (organization_id, kind, ref_id) values (v_row.organization_id, 'daily_digest', v_ref) on conflict do nothing;
        declare
            v_present integer;
            v_no_shows integer;
            v_open integer;
            v_leave integer;
            v_exceptions integer;
        begin
            select count(distinct a.user_id) into v_present from attendance_sessions a
            where a.organization_id = v_row.organization_id and public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) = v_yesterday;
            select count(*) into v_no_shows from manager_alert_log l join shift_assignments sa on sa.id = l.ref_id
            where l.kind = 'no_show' and l.organization_id = v_row.organization_id and sa.shift_date = v_yesterday;
            select count(*) into v_open from attendance_sessions a where a.organization_id = v_row.organization_id and a.status = 'clocked_in';
            select count(*) into v_leave from leave_requests lr where lr.organization_id = v_row.organization_id and lr.status = 'pending';
            select count(*) into v_exceptions from geofence_exceptions ge where ge.organization_id = v_row.organization_id and ge.status = 'pending_review';
            for v_to in select u.id from users u where u.organization_id = v_row.organization_id and u.is_owner and u.is_active loop
                perform public.create_prosm_time_notification(
                    v_row.organization_id, v_to, 'daily_digest', 'normal', 'Yesterday at a glance',
                    v_present || ' worked, ' || v_no_shows || ' missed a shift. Waiting: ' || v_leave || ' leave, ' || v_exceptions || ' exceptions. Clocked in now: ' || v_open || '.',
                    'organizations', v_ref,
                    jsonb_build_object('date', v_yesterday, 'present', v_present, 'noShows', v_no_shows, 'open', v_open, 'leave', v_leave, 'exceptions', v_exceptions)
                );
            end loop;
            v_digest := v_digest + 1;
        end;
    end loop;

    delete from manager_alert_log where sent_at < now() - interval '30 days';
    return jsonb_build_object('noShow', v_no_show, 'overtimeSoon', v_overtime, 'digest', v_digest);
end;
$$;
revoke all on function public.process_prosm_time_manager_alerts() from public, anon, authenticated;

select cron.schedule('prosm-time-manager-alerts', '*/5 * * * *', $cron$select public.process_prosm_time_manager_alerts();$cron$);

-- Attendance rate and the people often late or on overtime, for those who see attendance.
create or replace function public.get_prosm_time_attendance_insights(p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
    v_scheduled integer;
    v_attended integer;
    v_late jsonb;
    v_overtime jsonb;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not v_owner and not public.prosm_time_user_has_permission_internal(v_me, 'attendance.view') then raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED'; end if;
    if p_end_date < p_start_date or p_end_date - p_start_date > 62 then raise exception 'PERIOD TOO LONG'; end if;

    select count(*), count(*) filter (where exists (
               select 1 from attendance_sessions a
               where a.user_id = sa.user_id and public.prosm_time_work_date(a.clock_in_at, coalesce(a.site_id, sa.site_id), v_org) = sa.shift_date))
    into v_scheduled, v_attended
    from shift_assignments sa
    where sa.organization_id = v_org and sa.status = 'scheduled'
      and sa.shift_date between p_start_date and least(p_end_date, current_date)
      and public.prosm_time_day_type(sa.user_id, sa.site_id, sa.shift_date) = 'workday'
      and not exists (select 1 from leave_requests lr where lr.user_id = sa.user_id and lr.status = 'approved' and sa.shift_date between lr.start_date and lr.end_date)
      and (v_owner or sa.site_id = any(public.current_prosm_time_managed_site_ids()));

    with days as (
        select distinct a.user_id, public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) as day
        from attendance_sessions a
        where a.organization_id = v_org
          and public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) between p_start_date and p_end_date
          and public.prosm_time_session_counts(a.status, a.hours_review_status)
          and (v_owner or a.site_id = any(public.current_prosm_time_managed_site_ids()))
    ), summaries as (
        select d.user_id, (s ->> 'lateMinutes')::numeric as late, (s ->> 'overtimeMinutes')::numeric + (s ->> 'overtimePendingApprovalMinutes')::numeric as overtime
        from days d cross join lateral public.prosm_time_day_summary(d.user_id, d.day) s
    ), per_person as (
        select u.full_name as name, count(*) filter (where late > 0) as late_days, sum(late) as late_minutes, sum(overtime) as overtime_minutes,
               count(*) filter (where overtime > 0) as overtime_days
        from summaries join users u on u.id = summaries.user_id
        group by u.full_name
    )
    select coalesce((select jsonb_agg(jsonb_build_object('name', name, 'days', late_days, 'minutes', round(late_minutes)) order by late_days desc, late_minutes desc)
                     from (select * from per_person where late_days >= 2 order by late_days desc, late_minutes desc limit 5) x), '[]'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('name', name, 'days', overtime_days, 'minutes', round(overtime_minutes)) order by overtime_minutes desc)
                     from (select * from per_person where overtime_days >= 2 order by overtime_minutes desc limit 5) y), '[]'::jsonb)
    into v_late, v_overtime;

    return jsonb_build_object(
        'scheduled', v_scheduled, 'attended', v_attended,
        'rate', case when v_scheduled > 0 then round(100.0 * v_attended / v_scheduled, 1) end,
        'repeatLate', v_late, 'repeatOvertime', v_overtime
    );
end;
$$;
revoke all on function public.get_prosm_time_attendance_insights(date, date) from public, anon;
grant execute on function public.get_prosm_time_attendance_insights(date, date) to authenticated;

-- What a site's roster will cost: hours at each person's rate, the part past the
-- site's daily threshold (8 hours by default) at the overtime multiplier.
create or replace function public.get_prosm_time_schedule_cost(p_site_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_result jsonb;
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id()) then raise exception 'SITE NOT FOUND'; end if;
    if p_end_date < p_start_date or p_end_date - p_start_date > 62 then raise exception 'PERIOD TOO LONG'; end if;

    with shifts as (
        select sa.user_id, sa.shift_date,
               extract(epoch from (sa.end_time - sa.start_time + case when sa.end_time <= sa.start_time then interval '24 hours' else interval '0' end)) / 3600.0 as hours,
               coalesce(s.daily_overtime_threshold_minutes, 480) / 60.0 as threshold,
               (public.prosm_time_overtime_policy(sa.user_id, sa.site_id, sa.shift_date) ->> 'multiplierNormal')::numeric as multiplier
        from shift_assignments sa join sites s on s.id = sa.site_id
        where sa.site_id = p_site_id and sa.status = 'scheduled' and sa.shift_date between p_start_date and p_end_date
    ), priced as (
        select sh.*, least(sh.hours, sh.threshold) as regular, greatest(sh.hours - sh.threshold, 0) as overtime, r.currency,
               case r.rate_type when 'HOURLY' then r.rate_amount when 'MONTHLY' then r.rate_amount / 240 end as hourly
        from shifts sh
        left join lateral (
            select pr.rate_type, pr.rate_amount, pr.currency from worker_pay_rates pr
            where pr.user_id = sh.user_id and pr.effective_from <= sh.shift_date and (pr.effective_to is null or pr.effective_to >= sh.shift_date)
            order by pr.effective_from desc limit 1
        ) r on true
    )
    select jsonb_build_object(
        'shifts', count(*),
        'regularHours', round(coalesce(sum(regular), 0)::numeric, 1),
        'overtimeHours', round(coalesce(sum(overtime), 0)::numeric, 1),
        'regularCost', round(coalesce(sum(regular * hourly), 0)::numeric, 2),
        'overtimeCost', round(coalesce(sum(overtime * hourly * coalesce(multiplier, 1)), 0)::numeric, 2),
        'unpricedShifts', count(*) filter (where hourly is null),
        'currency', max(currency)
    ) into v_result from priced;
    return v_result;
end;
$$;
revoke all on function public.get_prosm_time_schedule_cost(uuid, date, date) from public, anon;
grant execute on function public.get_prosm_time_schedule_cost(uuid, date, date) to authenticated;

-- Project budgets against the labour they have cost so far.
create or replace function public.list_prosm_time_project_budgets()
returns table (project_id uuid, project_name text, site_name text, budget numeric, spent numeric, hours numeric, unpriced_hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    return query
    with worked as (
        select a.project_id, a.user_id, public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) as day,
               extract(epoch from (a.clock_out_at - a.clock_in_at)) / 3600.0 as h
        from attendance_sessions a
        where a.organization_id = v_org and a.project_id is not null and public.prosm_time_session_counts(a.status, a.hours_review_status)
    ), priced as (
        select w.project_id, w.h,
               case r.rate_type when 'HOURLY' then r.rate_amount when 'MONTHLY' then r.rate_amount / 240 end as hourly
        from worked w
        left join lateral (
            select pr.rate_type, pr.rate_amount from worker_pay_rates pr
            where pr.user_id = w.user_id and pr.effective_from <= w.day and (pr.effective_to is null or pr.effective_to >= w.day)
            order by pr.effective_from desc limit 1
        ) r on true
    )
    select p.id, p.name, s.name, p.budget_amount,
           round(coalesce((select sum(x.h * x.hourly) from priced x where x.project_id = p.id), 0)::numeric, 2),
           round(coalesce((select sum(x.h) from priced x where x.project_id = p.id), 0)::numeric, 1),
           round(coalesce((select sum(x.h) from priced x where x.project_id = p.id and x.hourly is null), 0)::numeric, 1)
    from projects p join sites s on s.id = p.site_id
    where s.organization_id = v_org and p.is_active
    order by s.name, p.name;
end;
$$;
revoke all on function public.list_prosm_time_project_budgets() from public, anon;
grant execute on function public.list_prosm_time_project_budgets() to authenticated;

create or replace function public.set_prosm_time_project_budget(p_project_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    if p_amount is not null and p_amount < 0 then raise exception 'INVALID BUDGET'; end if;
    update projects p set budget_amount = p_amount, updated_at = now()
    from sites s
    where p.id = p_project_id and s.id = p.site_id and s.organization_id = public.current_prosm_time_organization_id();
    if not found then raise exception 'PROJECT NOT FOUND'; end if;
end;
$$;
revoke all on function public.set_prosm_time_project_budget(uuid, numeric) from public, anon;
grant execute on function public.set_prosm_time_project_budget(uuid, numeric) to authenticated;

commit;
