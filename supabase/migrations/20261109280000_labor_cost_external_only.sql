-- 2026-11-09 (owner): "the labour cost report shows the company's employees, who already have their
-- payroll. Labour cost is about external labour: the contractor, each worker's pay and how it is
-- counted, and the total for the period."
-- The report is now external workers only: worker, contractor, site, rate, unit, days and hours
-- from the kiosk, and the amount for the period (hour x hours, day x days; week / month / year
-- through the pay runs' day-rate rule: month / day divisor, week = month x 12 / 52, year / 12).
-- Seen by the owner and whoever may see external labour pay, for the sites they manage.
-- Rollback: restore list_prosm_time_report_labor_cost from 20261109250000.

begin;

drop function if exists public.list_prosm_time_report_labor_cost(date, date);

create function public.list_prosm_time_report_labor_cost(p_start_date date, p_end_date date)
returns table (worker_name text, worker_number text, contractor_name text, site_name text, rate_amount numeric, rate_unit text,
               currency text, days integer, hours numeric, amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('kiosk');
    if not (v_owner or public.prosm_time_user_has_permission_internal(v_me, 'external_labor.view_pay')) then
        raise exception 'EXTERNAL LABOUR PAY AUTHORITY REQUIRED';
    end if;
    p_start_date := greatest(p_start_date, public.prosm_time_history_start_date(v_org));
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date then raise exception 'START AND END DATE ARE REQUIRED'; end if;
    if p_end_date - p_start_date > 92 then raise exception 'PERIOD TOO LONG'; end if;

    return query
    with worked as (
        select swa.site_id, swa.site_worker_id,
               public.prosm_time_work_date(swa.clock_in_at, swa.site_id, swa.organization_id) as day,
               extract(epoch from (swa.clock_out_at - swa.clock_in_at)) / 3600.0 as h
        from site_worker_attendance swa
        where swa.organization_id = v_org and swa.clock_out_at is not null
          and public.prosm_time_work_date(swa.clock_in_at, swa.site_id, swa.organization_id) between p_start_date and p_end_date
          and (v_owner or swa.site_id = any(public.current_prosm_time_managed_site_ids()))
    ), grouped as (
        select w.site_id, w.site_worker_id, sum(w.h)::numeric as h, count(distinct w.day)::integer as d
        from worked w group by w.site_id, w.site_worker_id
    )
    select sw.full_name, sw.worker_number, sw.contractor_name, s.name,
           r.rate_amount, r.rate_type, r.currency, g.d, round(g.h, 2),
           case r.rate_type
               when 'HOURLY' then round(g.h * r.rate_amount, 2)
               when 'DAILY' then round(g.d * r.rate_amount, 2)
               when 'WEEKLY' then round(g.d * r.rate_amount * 52 / 12 / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
               when 'MONTHLY' then round(g.d * r.rate_amount / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
               when 'YEARLY' then round(g.d * r.rate_amount / 12 / public.prosm_time_external_day_divisor(v_org, g.site_id, p_start_date, p_end_date), 2)
           end
    from grouped g
    join site_workers sw on sw.id = g.site_worker_id
    left join sites s on s.id = g.site_id
    left join lateral (
        select pr.rate_type, pr.rate_amount, pr.currency from worker_pay_rates pr
        where pr.site_worker_id = g.site_worker_id and pr.effective_from <= p_end_date and (pr.effective_to is null or pr.effective_to >= p_start_date)
        order by pr.effective_from desc limit 1
    ) r on true
    order by sw.contractor_name nulls last, sw.full_name, s.name;
end;
$function$;
revoke all on function public.list_prosm_time_report_labor_cost(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_labor_cost(date, date) to authenticated;

commit;
