-- 2026-11-02 (plan stage 8.1): a per-employee period summary for the organisation's
-- accountant, with saved column templates. It reads what exists and pays nobody.
-- Rollback: drop the functions below and payroll_export_templates.

begin;

create table public.payroll_export_templates (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 60),
    columns text[] not null check (cardinality(columns) between 1 and 30),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (organization_id, name)
);

alter table public.payroll_export_templates enable row level security;
revoke all on public.payroll_export_templates from anon, authenticated;

-- The time the timesheet takes off for a rejected out-of-area exception, so this
-- export and the timesheet give the same worked hours.
create or replace function public.prosm_time_rejected_cap_minutes(p_user_id uuid, p_start date, p_end date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(sum(extract(epoch from (ats.clock_out_at - least(ats.clock_out_at, cap.cap_at))) / 60), 0)::numeric
    from attendance_sessions ats
    join (
        select coalesce(ae.session_id, ps.attendance_session_id) as session_id, min(ge.created_at) as cap_at
        from geofence_exceptions ge
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        where ge.user_id = p_user_id
          and exists (
              select 1 from exception_actions ea
              where ea.geofence_exception_id = ge.id and ea.action_type = 'rejected'
                and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
          )
        group by coalesce(ae.session_id, ps.attendance_session_id)
    ) cap on cap.session_id = ats.id
    where ats.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_start and p_end
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);
$$;
revoke all on function public.prosm_time_rejected_cap_minutes(uuid, date, date) from public, anon, authenticated;

create or replace function public.prosm_time_can_export_payroll()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_is_owner()
        or public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'payroll.view_cost');
$$;
revoke all on function public.prosm_time_can_export_payroll() from public, anon;
grant execute on function public.prosm_time_can_export_payroll() to authenticated;

create or replace function public.list_prosm_time_report_payroll(p_start_date date, p_end_date date)
returns table (
    user_id uuid, full_name text, email text, days_worked integer,
    worked_minutes numeric, overtime_minutes numeric, overtime_weighted_minutes numeric,
    late_minutes numeric, early_leave_minutes numeric, deduction_minutes numeric,
    absence_days integer, paid_leave_days numeric, unpaid_leave_days numeric,
    leave_deduction numeric, allowances numeric, overtime_amount numeric, currency text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date then raise exception 'START AND END DATE ARE REQUIRED'; end if;
    if p_end_date - p_start_date > 92 then raise exception 'PERIOD TOO LONG'; end if;

    return query
    with people as (
        select u.id, u.full_name, u.email,
               public.prosm_time_rejected_cap_minutes(u.id, p_start_date, p_end_date) as capped
        from users u
        where u.organization_id = v_org
          and (v_owner or public.prosm_time_caller_has_authority_over(u.id))
          and (
              (u.status = 'active' and not u.is_owner)
              or exists (
                  select 1 from attendance_sessions ats
                  where ats.user_id = u.id
                    and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_start_date and p_end_date
              )
          )
    ), days as (
        select distinct ats.user_id, public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day
        from attendance_sessions ats join people p on p.id = ats.user_id
        where public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_start_date and p_end_date
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
    ), totals as (
        select d.user_id, count(*)::integer as days_worked,
               sum((s ->> 'workedMinutes')::numeric) as worked,
               sum((s ->> 'overtimeMinutes')::numeric) as overtime,
               sum((s ->> 'overtimeWeightedMinutes')::numeric) as weighted,
               sum((s ->> 'lateMinutes')::numeric) as late,
               sum((s ->> 'earlyLeaveMinutes')::numeric) as early,
               sum((s ->> 'deductionMinutes')::numeric) as deduction
        from days d cross join lateral public.prosm_time_day_summary(d.user_id, d.day) s
        group by d.user_id
    )
    select p.id, p.full_name, p.email, coalesce(t.days_worked, 0),
        round(greatest(coalesce(t.worked, 0) - p.capped, 0), 2),
        round(least(coalesce(t.overtime, 0), greatest(coalesce(t.worked, 0) - p.capped, 0)), 2),
        round(coalesce(t.weighted, 0), 2),
        round(coalesce(t.late, 0), 2), round(coalesce(t.early, 0), 2), round(coalesce(t.deduction, 0), 2),
        (select count(*)::integer from shift_assignments sa
          where sa.user_id = p.id and sa.status = 'scheduled'
            and sa.shift_date between p_start_date and p_end_date
            and public.prosm_time_day_type(sa.user_id, sa.site_id, sa.shift_date) = 'workday'
            and not exists (
                select 1 from attendance_sessions ats
                where ats.user_id = sa.user_id
                  and public.prosm_time_work_date(ats.clock_in_at, coalesce(ats.site_id, sa.site_id), v_org) = sa.shift_date
            )
            and not exists (
                select 1 from leave_requests lr
                where lr.user_id = sa.user_id and lr.status = 'approved' and sa.shift_date between lr.start_date and lr.end_date
            )),
        (select coalesce(sum(least(lr.end_date, p_end_date) - greatest(lr.start_date, p_start_date) + 1), 0)::numeric
           from leave_requests lr left join leave_types lt on lt.organization_id = lr.organization_id and lt.key = lr.leave_type
          where lr.user_id = p.id and lr.status = 'approved' and lr.start_date <= p_end_date and lr.end_date >= p_start_date
            and coalesce(lt.is_paid, true)),
        (select coalesce(sum(least(lr.end_date, p_end_date) - greatest(lr.start_date, p_start_date) + 1), 0)::numeric
           from leave_requests lr join leave_types lt on lt.organization_id = lr.organization_id and lt.key = lr.leave_type
          where lr.user_id = p.id and lr.status = 'approved' and lr.start_date <= p_end_date and lr.end_date >= p_start_date
            and not lt.is_paid),
        (select coalesce(-sum(a.amount), 0) from payroll_adjustments a
          where a.user_id = p.id and a.status = 'active' and a.kind = 'unpaid_leave_deduction' and a.work_date between p_start_date and p_end_date),
        (select coalesce(sum(coalesce(e.meal_allowance, 0) + coalesce(e.expatriation_allowance, 0) + coalesce(e.transportation_allowance, 0)
                           + coalesce(e.housing_allowance, 0) + coalesce(e.travel_allowance, 0) + coalesce(e.other_allowance, 0)), 0)
           from allowance_entries e where e.user_id = p.id and e.status = 'approved' and e.entry_date between p_start_date and p_end_date),
        (select coalesce(sum(coalesce(e.overtime_amount, 0) + coalesce(e.extra_days_amount, 0)), 0)
           from allowance_entries e where e.user_id = p.id and e.status = 'approved' and e.entry_date between p_start_date and p_end_date),
        coalesce((select r.currency from worker_pay_rates r where r.user_id = p.id order by r.effective_from desc limit 1), 'EGP')
    from people p left join totals t on t.user_id = p.id
    order by p.full_name;
end;
$$;
revoke all on function public.list_prosm_time_report_payroll(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_payroll(date, date) to authenticated;

create or replace function public.list_prosm_time_payroll_templates()
returns table (id uuid, name text, columns text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    return query
    select t.id, t.name, t.columns from payroll_export_templates t
    where t.organization_id = public.current_prosm_time_organization_id() order by t.name;
end;
$$;
revoke all on function public.list_prosm_time_payroll_templates() from public, anon;
grant execute on function public.list_prosm_time_payroll_templates() to authenticated;

create or replace function public.save_prosm_time_payroll_template(p_name text, p_columns text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    insert into payroll_export_templates (organization_id, name, columns, created_by)
    values (public.current_prosm_time_organization_id(), trim(p_name), p_columns, public.current_prosm_time_user_id())
    on conflict (organization_id, name) do update set columns = excluded.columns
    returning id into v_id;
    return v_id;
end;
$$;
revoke all on function public.save_prosm_time_payroll_template(text, text[]) from public, anon;
grant execute on function public.save_prosm_time_payroll_template(text, text[]) to authenticated;

create or replace function public.delete_prosm_time_payroll_template(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    delete from payroll_export_templates where id = p_id and organization_id = public.current_prosm_time_organization_id();
end;
$$;
revoke all on function public.delete_prosm_time_payroll_template(uuid) from public, anon;
grant execute on function public.delete_prosm_time_payroll_template(uuid) to authenticated;

commit;
