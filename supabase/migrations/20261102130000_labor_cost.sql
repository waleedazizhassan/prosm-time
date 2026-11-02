-- 2026-11-02 (plan stage 8.5): labour cost, hours by rate, per project, site and
-- employee, for those allowed to see pay. An hour counts at the rate in force on its
-- day; a monthly rate is divided by 240 hours (30 days of 8). No rate, no cost shown.
-- Rollback: drop the function.

begin;

create or replace function public.list_prosm_time_report_labor_cost(p_start_date date, p_end_date date)
returns table (project_name text, site_name text, user_full_name text, hours numeric, cost numeric, currency text)
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
    with worked as (
        select ats.project_id, ats.site_id, ats.user_id,
               public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day,
               extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 3600.0 as hours
        from attendance_sessions ats
        where ats.organization_id = v_org
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_start_date and p_end_date
          and (v_owner or public.prosm_time_caller_has_authority_over(ats.user_id))
    ), priced as (
        select w.*, r.currency,
               case r.rate_type when 'HOURLY' then r.rate_amount when 'MONTHLY' then r.rate_amount / 240 end as hourly
        from worked w
        left join lateral (
            select pr.rate_type, pr.rate_amount, pr.currency from worker_pay_rates pr
            where pr.user_id = w.user_id and pr.effective_from <= w.day and (pr.effective_to is null or pr.effective_to >= w.day)
            order by pr.effective_from desc limit 1
        ) r on true
    )
    select pj.name, s.name, u.full_name,
           round(sum(p.hours)::numeric, 2),
           case when bool_and(p.hourly is not null) then round(sum(p.hours::numeric * p.hourly), 2) end,
           max(p.currency)
    from priced p
    join users u on u.id = p.user_id
    left join sites s on s.id = p.site_id
    left join projects pj on pj.id = p.project_id
    group by pj.name, s.name, u.full_name
    order by pj.name nulls last, s.name, u.full_name;
end;
$$;
revoke all on function public.list_prosm_time_report_labor_cost(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_labor_cost(date, date) to authenticated;

commit;
