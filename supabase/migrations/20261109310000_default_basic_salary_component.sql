-- 2026-11-09 (owner: "the amount is not saved"): Ratomag had no payroll components at all, so a
-- person's payroll file had nowhere to enter the salary - the figure went into "fixed insurable
-- wage" instead. Every organisation now has a "Basic salary" component (fixed, earning, the basic,
-- insurable, taxable), created for those without one and for every new organisation; it can be
-- renamed or changed in Payroll settings like any component.
-- Rollback: delete the components this created (is_basic, name_en 'Basic salary', no profile values).

begin;

create or replace function public.prosm_time_seed_basic_component(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
    insert into payroll_components (organization_id, name_ar, name_en, category, source, calc_type, is_basic, include_in_net,
                                    show_in_payslip, show_in_summary, include_in_combined, prorate, sort_order, is_active, taxable, insurable)
    select p_org, 'الراتب الأساسي', 'Basic salary', 'earning', 'fixed', 'amount', true, true, true, true, false, true, 1, true, true, true
    where not exists (select 1 from payroll_components c where c.organization_id = p_org and c.is_basic);
$$;
revoke all on function public.prosm_time_seed_basic_component(uuid) from public, anon, authenticated;

select public.prosm_time_seed_basic_component(id) from public.organizations;

create or replace function public.prosm_time_seed_payroll_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into payroll_settings (organization_id, country_code, statutory)
    values (new.id, 'EG', coalesce((select config from payroll_country_packs where code = 'EG'), '{}'::jsonb))
    on conflict do nothing;
    perform public.prosm_time_seed_basic_component(new.id);
    return new;
end;
$$;
revoke all on function public.prosm_time_seed_payroll_settings() from public, anon, authenticated;

commit;
