-- PROSM Time - Phase 6 of PROSM Finance's own plan (2026-09-14):
-- PROSM Finance needs a "قسم مرتبات كامل وشامل" (complete payroll
-- section) so it doesn't need QuickBooks for payroll. Everything below
-- is EXPOSURE ONLY - no new PROSM Time table, no new PROSM Time UI
-- (per the user's own instruction: "اظهر اللي موجود في تايم بس مفتاح
-- API فقط" - show what's already in Time, via API key only). Reuses
-- the existing `payroll:read` scope (added 20260914200000) rather than
-- inventing 2-3 new scopes - allowances/leave/lateness are all
-- compensation-category data at the same sensitivity level as rate.
--
-- Three real, already-existing data sources, three thin export RPCs,
-- same service-role-only posture as list_prosm_time_worker_rates_export:
--   1. allowance_entries (20260902140000) - daily, per-worker, APPROVED
--      allowance amounts + already-computed overtime_hours/overtime_days.
--   2. leave_requests (20260908200000) - APPROVED requests of every
--      leave_type (including 'unpaid') - PROSM Finance decides which
--      types reduce pay, not PROSM Time.
--   3. timesheets.total_deduction_minutes (added 20260902130000) -
--      lateness-past-grace minutes, the only monetary-adjacent
--      deduction concept that exists in this schema today.

begin;

create or replace function public.list_prosm_time_allowances_export(
    p_organization_id uuid,
    p_since date,
    p_until date
)
returns table (
    user_id uuid,
    employee_name text,
    employee_email text,
    entry_date date,
    meal_allowance numeric,
    expatriation_allowance numeric,
    transportation_allowance numeric,
    housing_allowance numeric,
    travel_allowance numeric,
    other_allowance numeric,
    other_allowance_note text,
    overtime_hours numeric,
    overtime_days numeric
)
language sql
stable
security definer
set search_path = public
as $function$
    select
        ae.user_id,
        u.full_name,
        u.email,
        ae.entry_date,
        ae.meal_allowance,
        ae.expatriation_allowance,
        ae.transportation_allowance,
        ae.housing_allowance,
        ae.travel_allowance,
        ae.other_allowance,
        ae.other_allowance_note,
        ae.overtime_hours,
        ae.overtime_days
    from allowance_entries ae
    join users u on u.id = ae.user_id
    where ae.organization_id = p_organization_id
      and ae.status = 'approved'
      and ae.entry_date between p_since and p_until
    order by ae.entry_date;
$function$;

revoke execute on function public.list_prosm_time_allowances_export(uuid, date, date) from public, anon, authenticated;
grant execute on function public.list_prosm_time_allowances_export(uuid, date, date) to service_role;

create or replace function public.list_prosm_time_leave_export(
    p_organization_id uuid,
    p_since date,
    p_until date
)
returns table (
    user_id uuid,
    employee_name text,
    employee_email text,
    leave_type text,
    start_date date,
    end_date date,
    days_count numeric
)
language sql
stable
security definer
set search_path = public
as $function$
    select
        lr.user_id,
        u.full_name,
        u.email,
        lr.leave_type,
        lr.start_date,
        lr.end_date,
        lr.days_count
    from leave_requests lr
    join users u on u.id = lr.user_id
    where lr.organization_id = p_organization_id
      and lr.status = 'approved'
      -- overlaps the window, not just starts inside it - a leave
      -- spanning period boundaries should still count.
      and lr.start_date <= p_until
      and lr.end_date >= p_since
    order by lr.start_date;
$function$;

revoke execute on function public.list_prosm_time_leave_export(uuid, date, date) from public, anon, authenticated;
grant execute on function public.list_prosm_time_leave_export(uuid, date, date) to service_role;

create or replace function public.list_prosm_time_payroll_deductions_export(
    p_organization_id uuid,
    p_since date,
    p_until date
)
returns table (
    user_id uuid,
    employee_name text,
    employee_email text,
    total_deduction_minutes double precision
)
language sql
stable
security definer
set search_path = public
as $function$
    select
        ts.user_id,
        u.full_name,
        u.email,
        sum(ts.total_deduction_minutes) as total_deduction_minutes
    from timesheets ts
    join users u on u.id = ts.user_id
    where ts.organization_id = p_organization_id
      and ts.period_start <= p_until
      and ts.period_end >= p_since
    group by ts.user_id, u.full_name, u.email;
$function$;

revoke execute on function public.list_prosm_time_payroll_deductions_export(uuid, date, date) from public, anon, authenticated;
grant execute on function public.list_prosm_time_payroll_deductions_export(uuid, date, date) to service_role;

commit;
