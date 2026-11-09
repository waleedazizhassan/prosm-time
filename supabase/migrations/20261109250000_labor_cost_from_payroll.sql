-- 2026-11-09 (owner): "the labour cost report needs fixing; there is no report for external labour."
-- The labour cost report priced employees only, from a separate pay rate on the person's page, and
-- grouped by project (projects are hidden). Now:
--   * employees: the hourly cost comes from the basic salary in their payroll profile (monthly basic
--     / (payroll day divisor x hours per day)); the older pay rate is used only when there is no
--     payroll basic; rows say which one was used;
--   * external workers are included (for whoever may see their pay): hours and days from the kiosk,
--     priced by their rate - by the hour, by the day, and week / month / year through the same
--     day-rate rule the pay runs use (month / day divisor; week = month x 12 / 52; year / 12);
--   * grouped by kind, site and person; no project column.
-- Same permission (payroll export authority) and the same scope (the owner, or the people and
-- sites under the caller's authority); still at most 92 days.
-- Rollback: restore list_prosm_time_report_labor_cost from 20261102130000.

begin;

drop function if exists public.list_prosm_time_report_labor_cost(date, date);

create function public.list_prosm_time_report_labor_cost(p_start_date date, p_end_date date)
returns table (kind text, site_name text, user_full_name text, hours numeric, days integer, cost numeric, currency text, rate_basis text)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
    v_divisor numeric;
    v_hours_per_day numeric;
    v_external boolean;
begin
    p_start_date := greatest(p_start_date, public.prosm_time_history_start_date(v_org));
    perform public.prosm_time_require_feature('labor_cost');
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_can_export_payroll() then raise exception 'PAYROLL AUTHORITY REQUIRED'; end if;
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date then raise exception 'START AND END DATE ARE REQUIRED'; end if;
    if p_end_date - p_start_date > 92 then raise exception 'PERIOD TOO LONG'; end if;
    select coalesce(ps.day_divisor, 30), coalesce(ps.hours_per_day, 8) into v_divisor, v_hours_per_day from payroll_settings ps where ps.organization_id = v_org;
    v_divisor := coalesce(v_divisor, 30);
    v_hours_per_day := coalesce(v_hours_per_day, 8);
    v_external := v_owner or public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'external_labor.view_pay');

    return query
    with worked as (
        select ats.site_id, ats.user_id,
               public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day,
               extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 3600.0 as h
        from attendance_sessions ats
        where ats.organization_id = v_org
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_start_date and p_end_date
          and (v_owner or public.prosm_time_caller_has_authority_over(ats.user_id))
    ), priced as (
        select w.*,
               coalesce(pb.currency, r.currency) as cur,
               case when pb.amount is not null then pb.amount / (v_divisor * v_hours_per_day)
                    else case r.rate_type when 'HOURLY' then r.rate_amount
                                          when 'DAILY' then r.rate_amount / v_hours_per_day
                                          when 'WEEKLY' then r.rate_amount * 52 / 12 / (v_divisor * v_hours_per_day)
                                          when 'MONTHLY' then r.rate_amount / (v_divisor * v_hours_per_day)
                                          when 'YEARLY' then r.rate_amount / 12 / (v_divisor * v_hours_per_day) end end as hourly,
               case when pb.amount is not null then 'payroll' when r.rate_type is not null then 'rate' end as basis
        from worked w
        left join lateral (
            select ppc.amount, p.currency from payroll_profiles p
            join payroll_profile_components ppc on ppc.profile_id = p.id
            join payroll_components c on c.id = ppc.component_id and c.is_basic and c.calc_type = 'amount'
            where p.user_id = w.user_id and p.is_active and ppc.effective_from <= w.day and (ppc.effective_to is null or ppc.effective_to >= w.day)
            order by ppc.effective_from desc limit 1
        ) pb on true
        left join lateral (
            select pr.rate_type, pr.rate_amount, pr.currency from worker_pay_rates pr
            where pr.user_id = w.user_id and pr.effective_from <= w.day and (pr.effective_to is null or pr.effective_to >= w.day)
            order by pr.effective_from desc limit 1
        ) r on true
    ), employees as (
        select 'employee'::text as kind, s.name as site_name, u.full_name as user_full_name,
               round(sum(p.h)::numeric, 2) as hours, count(distinct p.day)::integer as days,
               case when bool_and(p.hourly is not null) then round(sum(p.h::numeric * p.hourly), 2) end as cost,
               max(p.cur) as currency, case when bool_and(p.basis = 'payroll') then 'payroll' when bool_or(p.basis is not null) then 'rate' end as rate_basis
        from priced p join users u on u.id = p.user_id left join sites s on s.id = p.site_id
        group by s.name, u.full_name
    ), ext_worked as (
        select swa.site_id, swa.site_worker_id,
               public.prosm_time_work_date(swa.clock_in_at, swa.site_id, swa.organization_id) as day,
               extract(epoch from (swa.clock_out_at - swa.clock_in_at)) / 3600.0 as h
        from site_worker_attendance swa
        where v_external and swa.organization_id = v_org and swa.clock_out_at is not null
          and public.prosm_time_work_date(swa.clock_in_at, swa.site_id, swa.organization_id) between p_start_date and p_end_date
          and (v_owner or swa.site_id = any(public.current_prosm_time_managed_site_ids()))
    ), ext_grouped as (
        select e.site_id, e.site_worker_id, sum(e.h)::numeric as h, count(distinct e.day)::integer as d
        from ext_worked e group by e.site_id, e.site_worker_id
    ), externals as (
        select 'external'::text, s.name, sw.full_name, round(g.h, 2), g.d,
               case r.rate_type
                   when 'HOURLY' then round(g.h * r.rate_amount, 2)
                   when 'DAILY' then round(g.d * r.rate_amount, 2)
                   when 'WEEKLY' then round(g.d * r.rate_amount * 52 / 12 / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
                   when 'MONTHLY' then round(g.d * r.rate_amount / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
                   when 'YEARLY' then round(g.d * r.rate_amount / 12 / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
               end,
               r.currency, case when r.rate_type is not null then 'external_rate' end
        from ext_grouped g
        join site_workers sw on sw.id = g.site_worker_id
        left join sites s on s.id = g.site_id
        left join lateral (
            select pr.rate_type, pr.rate_amount, pr.currency from worker_pay_rates pr
            where pr.site_worker_id = g.site_worker_id and pr.effective_from <= p_end_date and (pr.effective_to is null or pr.effective_to >= p_start_date)
            order by pr.effective_from desc limit 1
        ) r on true
    )
    select * from employees
    union all
    select * from externals
    order by 1, 2 nulls last, 3;
end;
$function$;
revoke all on function public.list_prosm_time_report_labor_cost(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_labor_cost(date, date) to authenticated;

commit;
