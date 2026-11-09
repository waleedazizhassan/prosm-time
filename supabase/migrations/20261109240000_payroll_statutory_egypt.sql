-- 2026-11-09 (owner): "Egyptian law is the default, and it can be changed if we sell in another country."
--
-- Statutory deductions, computed in every new payroll cycle from the organisation's settings:
--   * social insurance (Law 148/2019): employee 11% / employer 18.75% of the insurable wage, held
--     between the monthly minimum and maximum (2026: EGP 2,700 - 16,700); the insurable wage is the
--     basic salary, all earnings, or the components marked insurable - or a fixed insurable wage
--     set on the person's profile; a person can be exempt;
--   * salary income tax (Law 91/2005 as amended, 2026 table): annual brackets after the personal
--     exemption (EGP 20,000), employee insurance deducted first, and the high-income tiers that
--     remove the lower brackets (above 600k, 700k, 800k, 900k, 1.2m); a person can be exempt;
--     components can be marked not taxable;
--   * the martyrs' fund: 0.05% of gross pay.
-- Every figure lives in data, not in code: a country pack (payroll_country_packs, EG seeded) is
-- copied into payroll_settings.statutory, where the organisation edits it; "back to the country's
-- values" copies the pack again. A new country is a new pack row.
--
-- Cycles keep the settings snapshot they were created with, so cycles created before this change
-- (no statutory section in their snapshot) are computed exactly as before; approved versions are
-- frozen as always.
--
-- Also: a fixed component can apply to everyone with a payroll profile (with a default amount or
-- its percentage) - a person's own value, when set, wins.
--
-- Rollback: drop the added columns, payroll_country_packs and the new functions; restore
-- prosm_time_payroll_recalc_employee, prosm_time_payroll_build_employee,
-- save_prosm_time_payroll_component and save_prosm_time_payroll_profile from 20261108130000.

begin;

-- ---------------------------------------------------------------- country packs
create table if not exists public.payroll_country_packs (
    code text primary key check (code ~ '^[A-Z]{2}$'),
    name_ar text not null,
    name_en text not null,
    config jsonb not null,
    source_note text,
    updated_at timestamptz not null default now()
);
alter table public.payroll_country_packs enable row level security;
revoke all on public.payroll_country_packs from public, anon, authenticated;

insert into public.payroll_country_packs (code, name_ar, name_en, config, source_note) values ('EG', 'مصر', 'Egypt', jsonb_build_object(
    'insurance', jsonb_build_object(
        'enabled', true,
        'nameAr', 'التأمينات الاجتماعية (حصة العامل)', 'nameEn', 'Social insurance (employee)',
        'employerNameAr', 'التأمينات الاجتماعية (حصة صاحب العمل)', 'employerNameEn', 'Social insurance (employer)',
        'employeeRate', 11, 'employerRate', 18.75,
        'minWage', 2700, 'maxWage', 16700,
        'base', 'basic'),
    'incomeTax', jsonb_build_object(
        'enabled', true,
        'nameAr', 'ضريبة كسب العمل', 'nameEn', 'Salary income tax',
        'personalExemption', 20000,
        'insuranceDeductible', true,
        'brackets', jsonb_build_array(
            jsonb_build_object('upTo', 40000, 'rate', 0),
            jsonb_build_object('upTo', 55000, 'rate', 10),
            jsonb_build_object('upTo', 70000, 'rate', 15),
            jsonb_build_object('upTo', 200000, 'rate', 20),
            jsonb_build_object('upTo', 400000, 'rate', 22.5),
            jsonb_build_object('upTo', 1200000, 'rate', 25),
            jsonb_build_object('upTo', null, 'rate', 27.5)),
        'tiers', jsonb_build_array(
            jsonb_build_object('above', 600000, 'startBracket', 1),
            jsonb_build_object('above', 700000, 'startBracket', 2),
            jsonb_build_object('above', 800000, 'startBracket', 3),
            jsonb_build_object('above', 900000, 'startBracket', 4),
            jsonb_build_object('above', 1200000, 'startBracket', 5))),
    'martyrsFund', jsonb_build_object(
        'enabled', true,
        'nameAr', 'صندوق تكريم الشهداء', 'nameEn', 'Martyrs'' fund',
        'rate', 0.05)),
    'Values for 2026: NOSI insurable wage 2,700-16,700 from 1 Jan 2026; salary tax table of Law 7/2024. Review every January.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- settings, components, profiles
alter table public.payroll_settings add column if not exists country_code text not null default 'EG';
alter table public.payroll_settings add column if not exists statutory jsonb not null default '{}'::jsonb;
update public.payroll_settings set statutory = (select config from payroll_country_packs where code = 'EG')
where statutory = '{}'::jsonb;

-- new organisations start from the Egyptian pack
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
    return new;
end;
$$;
revoke all on function public.prosm_time_seed_payroll_settings() from public, anon, authenticated;

alter table public.payroll_components add column if not exists taxable boolean not null default true;
alter table public.payroll_components add column if not exists insurable boolean not null default false;
alter table public.payroll_components add column if not exists applies_to_all boolean not null default false;
alter table public.payroll_components add column if not exists default_amount numeric(14,2) check (default_amount is null or default_amount >= 0);
alter table public.payroll_components drop constraint if exists payroll_components_applies_to_all_fixed;
alter table public.payroll_components add constraint payroll_components_applies_to_all_fixed check (not applies_to_all or source = 'fixed');
-- the basic salary is insurable by default
update public.payroll_components set insurable = true where is_basic and not insurable;

alter table public.payroll_profiles add column if not exists insurance_exempt boolean not null default false;
alter table public.payroll_profiles add column if not exists insurable_wage numeric(14,2) check (insurable_wage is null or insurable_wage >= 0);
alter table public.payroll_profiles add column if not exists tax_exempt boolean not null default false;

-- lines carry whether they are taxable / insurable (copied from the component when the line is made)
alter table public.payroll_cycle_lines add column if not exists taxable boolean not null default true;
alter table public.payroll_cycle_lines add column if not exists insurable boolean not null default false;
alter table public.payroll_cycle_lines drop constraint if exists payroll_cycle_lines_source_check;
alter table public.payroll_cycle_lines add constraint payroll_cycle_lines_source_check
    check (source in ('fixed', 'variable', 'installment', 'attendance_suggestion', 'import', 'statutory'));

-- copy the flags onto lines made from components (variable lines, imports...) whatever made them
create or replace function public.prosm_time_payroll_line_flags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.component_id is not null and new.source <> 'statutory' then
        select c.taxable, c.insurable into new.taxable, new.insurable from payroll_components c where c.id = new.component_id;
        new.taxable := coalesce(new.taxable, true);
        new.insurable := coalesce(new.insurable, false);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_line_flags() from public, anon, authenticated;
drop trigger if exists payroll_cycle_lines_flags on public.payroll_cycle_lines;
create trigger payroll_cycle_lines_flags before insert on public.payroll_cycle_lines
    for each row execute function public.prosm_time_payroll_line_flags();

-- ---------------------------------------------------------------- the tax table
-- Annual tax on annual taxable income (after the exemption). Brackets: [{upTo, rate}] ascending,
-- the last with upTo null. Tiers: [{above, startBracket}] - above that income, the brackets below
-- startBracket are dropped and that bracket starts from zero (Egypt's high-income rule).
create or replace function public.prosm_time_payroll_income_tax(p_annual numeric, p_cfg jsonb)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
    v_brackets jsonb := coalesce(p_cfg -> 'brackets', '[]'::jsonb);
    v_start integer := 0;
    v_tier jsonb;
    v_i integer;
    v_lower numeric := 0;
    v_upper numeric;
    v_tax numeric := 0;
begin
    if p_annual is null or p_annual <= 0 or jsonb_array_length(v_brackets) = 0 then return 0; end if;
    for v_tier in select value from jsonb_array_elements(coalesce(p_cfg -> 'tiers', '[]'::jsonb)) loop
        if p_annual > (v_tier ->> 'above')::numeric then
            v_start := greatest(v_start, (v_tier ->> 'startBracket')::integer);
        end if;
    end loop;
    v_start := least(v_start, jsonb_array_length(v_brackets) - 1);
    for v_i in v_start .. jsonb_array_length(v_brackets) - 1 loop
        v_upper := nullif(v_brackets -> v_i ->> 'upTo', '')::numeric;
        if v_upper is null or p_annual < v_upper then v_upper := p_annual; end if;
        if v_upper > v_lower then
            v_tax := v_tax + (v_upper - v_lower) * coalesce((v_brackets -> v_i ->> 'rate')::numeric, 0) / 100;
        end if;
        v_lower := greatest(v_lower, v_upper);
        exit when v_lower >= p_annual;
    end loop;
    return round(v_tax, 2);
end;
$$;
revoke all on function public.prosm_time_payroll_income_tax(numeric, jsonb) from public, anon;
grant execute on function public.prosm_time_payroll_income_tax(numeric, jsonb) to authenticated;

-- ---------------------------------------------------------------- the calculation
create or replace function public.prosm_time_payroll_recalc_employee(p_cycle_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ce payroll_cycle_employees%rowtype;
    v_factor numeric;
    v_basic numeric;
    v_earnings_base numeric;
    v_line record;
    v_base numeric;
    v_cfg jsonb;
    v_profile payroll_profiles%rowtype;
    v_gross numeric;
    v_taxable numeric;
    v_insurable numeric;
    v_ins_employee numeric := 0;
    v_annual numeric;
    v_tax numeric;
    v_sec jsonb;
begin
    select * into v_ce from payroll_cycle_employees where id = p_cycle_employee_id;
    v_factor := v_ce.proration_factor;
    -- 1. amount lines (prorated when the component says so)
    update payroll_cycle_lines set amount = round(raw_amount * case when prorate then v_factor else 1 end, 2), base_amount = null
    where cycle_employee_id = p_cycle_employee_id and calc_type = 'amount' and source <> 'statutory';
    select coalesce(sum(amount), 0) into v_basic from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and is_basic;
    select coalesce(sum(amount), 0) into v_earnings_base from payroll_cycle_lines
    where cycle_employee_id = p_cycle_employee_id and calc_type = 'amount' and category in ('earning', 'allowance') and include_in_net;
    -- 2. percentage lines, from the basic salary, a component's amount, or the total earnings
    for v_line in select * from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and calc_type = 'percent' loop
        v_base := case v_line.percent_base
            when 'basic' then v_basic
            when 'earnings' then v_earnings_base
            when 'component' then coalesce((select sum(amount) from payroll_cycle_lines b
                                            where b.cycle_employee_id = p_cycle_employee_id and b.component_id = v_line.base_component_id and b.calc_type = 'amount'), 0)
            else 0 end;
        update payroll_cycle_lines set base_amount = round(v_base, 2), amount = round(v_base * v_line.percent / 100, 2), updated_at = now()
        where id = v_line.id;
    end loop;

    -- 3. statutory lines (2026-11-09), from the cycle's own snapshot of the organisation's rules
    delete from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and source = 'statutory';
    select policy_snapshot -> 'statutory' into v_cfg from payroll_cycles where id = v_ce.cycle_id;
    select * into v_profile from payroll_profiles where user_id = v_ce.user_id and organization_id = v_ce.organization_id;
    if v_cfg is not null and v_cfg <> '{}'::jsonb and v_profile.id is not null and v_profile.is_active then
        select coalesce(sum(amount) filter (where category in ('earning', 'allowance') and include_in_net), 0),
               coalesce(sum(amount) filter (where category in ('earning', 'allowance') and include_in_net and taxable), 0),
               coalesce(sum(amount) filter (where category in ('earning', 'allowance') and include_in_net and insurable), 0)
        into v_gross, v_taxable, v_insurable
        from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id;

        -- social insurance
        v_sec := v_cfg -> 'insurance';
        if coalesce((v_sec ->> 'enabled')::boolean, false) and not v_profile.insurance_exempt then
            v_base := coalesce(v_profile.insurable_wage, case coalesce(v_sec ->> 'base', 'basic')
                when 'earnings' then v_gross when 'flagged' then v_insurable else v_basic end);
            if v_base > 0 then
                v_base := greatest(coalesce((v_sec ->> 'minWage')::numeric, 0), least(v_base, coalesce((v_sec ->> 'maxWage')::numeric, v_base)));
                v_ins_employee := round(v_base * coalesce((v_sec ->> 'employeeRate')::numeric, 0) / 100, 2);
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, calc_type, percent, base_amount,
                                                 raw_amount, amount, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, p_cycle_employee_id, coalesce(v_sec ->> 'nameAr', 'التأمينات الاجتماعية'), v_sec ->> 'nameEn', 'deduction', 'statutory', 'percent',
                        (v_sec ->> 'employeeRate')::numeric, round(v_base, 2), v_ins_employee, v_ins_employee, true, true, true, false, 800, false, false,
                        jsonb_build_object('rule', 'insurance_employee'));
                if coalesce((v_sec ->> 'employerRate')::numeric, 0) > 0 then
                    -- the employer's share: a cost, outside the employee's net and payslip
                    insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, calc_type, percent, base_amount,
                                                     raw_amount, amount, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                    values (v_ce.organization_id, p_cycle_employee_id, coalesce(v_sec ->> 'employerNameAr', 'حصة صاحب العمل'), v_sec ->> 'employerNameEn', 'deduction', 'statutory', 'percent',
                            (v_sec ->> 'employerRate')::numeric, round(v_base, 2), round(v_base * (v_sec ->> 'employerRate')::numeric / 100, 2),
                            round(v_base * (v_sec ->> 'employerRate')::numeric / 100, 2), false, false, false, false, 990, false, false,
                            jsonb_build_object('rule', 'insurance_employer'));
                end if;
            end if;
        end if;

        -- salary income tax: monthly taxable pay x 12, less the exemption, through the annual table, / 12
        v_sec := v_cfg -> 'incomeTax';
        if coalesce((v_sec ->> 'enabled')::boolean, false) and not v_profile.tax_exempt and v_taxable > 0 then
            v_annual := (v_taxable - case when coalesce((v_sec ->> 'insuranceDeductible')::boolean, true) then v_ins_employee else 0 end) * 12
                        - coalesce((v_sec ->> 'personalExemption')::numeric, 0);
            v_tax := round(public.prosm_time_payroll_income_tax(v_annual, v_sec) / 12, 2);
            if v_tax > 0 then
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, calc_type, base_amount,
                                                 raw_amount, amount, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, p_cycle_employee_id, coalesce(v_sec ->> 'nameAr', 'ضريبة كسب العمل'), v_sec ->> 'nameEn', 'deduction', 'statutory', 'amount',
                        round(greatest(v_annual, 0), 2), v_tax, v_tax, true, true, true, false, 810, false, false,
                        jsonb_build_object('rule', 'income_tax', 'annualTaxable', round(greatest(v_annual, 0), 2)));
            end if;
        end if;

        -- the martyrs' fund, a share of gross pay
        v_sec := v_cfg -> 'martyrsFund';
        if coalesce((v_sec ->> 'enabled')::boolean, false) and v_gross > 0 and coalesce((v_sec ->> 'rate')::numeric, 0) > 0 then
            v_tax := round(v_gross * (v_sec ->> 'rate')::numeric / 100, 2);
            if v_tax > 0 then
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, calc_type, percent, base_amount,
                                                 raw_amount, amount, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, p_cycle_employee_id, coalesce(v_sec ->> 'nameAr', 'صندوق الشهداء'), v_sec ->> 'nameEn', 'deduction', 'statutory', 'percent',
                        (v_sec ->> 'rate')::numeric, round(v_gross, 2), v_tax, v_tax, true, true, true, false, 820, false, false,
                        jsonb_build_object('rule', 'martyrs_fund'));
            end if;
        end if;
    end if;

    -- 4. totals
    update payroll_cycle_employees e set
        total_earnings = t.earnings,
        total_deductions = t.deductions,
        total_installments = t.installments,
        net_salary = t.earnings - t.deductions - t.installments,
        base_salary = t.basic,
        total_allowances = t.allowances,
        combined_total = t.basic + t.allowances,
        updated_at = now()
    from (
        select coalesce(sum(amount) filter (where category in ('earning', 'allowance') and include_in_net), 0) as earnings,
               coalesce(sum(amount) filter (where category = 'deduction' and include_in_net), 0) as deductions,
               coalesce(sum(amount) filter (where category = 'installment' and include_in_net), 0) as installments,
               coalesce(sum(amount) filter (where is_basic), 0) as basic,
               coalesce(sum(amount) filter (where category = 'allowance' and include_in_combined), 0) as allowances
        from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id
    ) t
    where e.id = p_cycle_employee_id;
end;
$$;
revoke all on function public.prosm_time_payroll_recalc_employee(uuid) from public, anon, authenticated;

-- fixed components for everyone: added for each person with a profile who has no own value
do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_payroll_build_employee(uuid)'::regprocedure);
    v_anchor text := '    where c.organization_id = v_ce.organization_id and c.is_active and c.source = ''fixed'';';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'build_employee anchor not found'; end if;
    v_def := replace(v_def, v_anchor, v_anchor || '

    -- 2026-11-09: components that apply to everyone, for whoever has no own value
    insert into payroll_cycle_lines (organization_id, cycle_employee_id, component_id, name_ar, name_en, category, source, calc_type, percent, percent_base,
                                     base_component_id, is_basic, raw_amount, prorate, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order)
    select v_ce.organization_id, v_ce.id, c.id, c.name_ar, c.name_en, c.category, ''fixed'', c.calc_type, c.percent, c.percent_base,
           c.base_component_id, c.is_basic, coalesce(c.default_amount, 0), c.prorate, c.include_in_net, c.show_in_payslip, c.show_in_summary, c.include_in_combined, c.sort_order
    from payroll_components c
    where c.organization_id = v_ce.organization_id and c.is_active and c.source = ''fixed'' and c.applies_to_all
      and not exists (select 1 from payroll_cycle_lines l where l.cycle_employee_id = v_ce.id and l.component_id = c.id);');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- saving components and profiles (new fields)
do $patch$
declare
    v_def text := pg_get_functiondef('public.save_prosm_time_payroll_component(uuid,jsonb)'::regprocedure);
begin
    if position('coalesce((p_component ->> ''is_active'')::boolean, true))
        returning id into v_id;' in v_def) = 0 then raise exception 'component insert anchor not found'; end if;
    v_def := replace(v_def, 'coalesce((p_component ->> ''is_active'')::boolean, true))
        returning id into v_id;', 'coalesce((p_component ->> ''is_active'')::boolean, true))
        returning id into v_id;
        update payroll_components set
            taxable = coalesce((p_component ->> ''taxable'')::boolean, true),
            insurable = coalesce((p_component ->> ''insurable'')::boolean, coalesce((p_component ->> ''is_basic'')::boolean, false)),
            applies_to_all = coalesce((p_component ->> ''applies_to_all'')::boolean, false),
            default_amount = nullif(p_component ->> ''default_amount'', '''')::numeric
        where id = v_id;');
    if position('            is_active = coalesce((p_component ->> ''is_active'')::boolean, is_active),' in v_def) = 0 then raise exception 'component update anchor not found'; end if;
    v_def := replace(v_def, '            is_active = coalesce((p_component ->> ''is_active'')::boolean, is_active),',
        '            is_active = coalesce((p_component ->> ''is_active'')::boolean, is_active),
            taxable = coalesce((p_component ->> ''taxable'')::boolean, taxable),
            insurable = coalesce((p_component ->> ''insurable'')::boolean, insurable),
            applies_to_all = coalesce((p_component ->> ''applies_to_all'')::boolean, applies_to_all),
            default_amount = case when p_component ? ''default_amount'' then nullif(p_component ->> ''default_amount'', '''')::numeric else default_amount end,');
    execute v_def;

    v_def := pg_get_functiondef('public.save_prosm_time_payroll_profile(uuid,jsonb)'::regprocedure);
    if position('    returning id into v_id;
    return jsonb_build_object(''success'', true, ''profileId'', v_id);' in v_def) = 0 then raise exception 'profile anchor not found'; end if;
    v_def := replace(v_def, '    returning id into v_id;
    return jsonb_build_object(''success'', true, ''profileId'', v_id);', '    returning id into v_id;
    -- 2026-11-09: insurance and tax for this person
    update payroll_profiles set
        insurance_exempt = case when p_profile ? ''insurance_exempt'' then coalesce((p_profile ->> ''insurance_exempt'')::boolean, false) else insurance_exempt end,
        insurable_wage = case when p_profile ? ''insurable_wage'' then nullif(p_profile ->> ''insurable_wage'', '''')::numeric else insurable_wage end,
        tax_exempt = case when p_profile ? ''tax_exempt'' then coalesce((p_profile ->> ''tax_exempt'')::boolean, false) else tax_exempt end
    where id = v_id;
    return jsonb_build_object(''success'', true, ''profileId'', v_id);');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- the rules: read, save, back to the country's values
create or replace function public.get_prosm_time_payroll_statutory()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_settings payroll_settings%rowtype;
begin
    perform public.prosm_time_payroll_require('payroll.access', null::uuid)
        where not public.prosm_time_payroll_allows('payroll.manage_settings', null);
    select * into v_settings from payroll_settings where organization_id = public.current_prosm_time_organization_id();
    return jsonb_build_object(
        'countryCode', v_settings.country_code,
        'config', v_settings.statutory,
        'countryConfig', (select config from payroll_country_packs where code = v_settings.country_code),
        'countries', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'nameAr', name_ar, 'nameEn', name_en, 'note', source_note) order by code) from payroll_country_packs), '[]'::jsonb));
end;
$$;
revoke all on function public.get_prosm_time_payroll_statutory() from public, anon;
grant execute on function public.get_prosm_time_payroll_statutory() to authenticated;

create or replace function public.save_prosm_time_payroll_statutory(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_ins jsonb := p_config -> 'insurance';
    v_tax jsonb := p_config -> 'incomeTax';
    v_fund jsonb := p_config -> 'martyrsFund';
    v_prev numeric := 0;
    v_b jsonb;
    v_n integer;
    v_i integer := 0;
begin
    perform public.prosm_time_payroll_require('payroll.manage_settings', null);
    if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'INVALID STATUTORY RULES'; end if;
    if v_ins is not null then
        if coalesce((v_ins ->> 'employeeRate')::numeric, 0) not between 0 and 100 or coalesce((v_ins ->> 'employerRate')::numeric, 0) not between 0 and 100 then
            raise exception 'A RATE MUST BE BETWEEN 0 AND 100';
        end if;
        if coalesce((v_ins ->> 'minWage')::numeric, 0) < 0 or (v_ins ->> 'maxWage') is not null and (v_ins ->> 'maxWage')::numeric < coalesce((v_ins ->> 'minWage')::numeric, 0) then
            raise exception 'THE MAXIMUM INSURABLE WAGE MUST NOT BE BELOW THE MINIMUM';
        end if;
        if coalesce(v_ins ->> 'base', 'basic') not in ('basic', 'earnings', 'flagged') then raise exception 'INVALID INSURANCE BASE'; end if;
    end if;
    if v_tax is not null then
        v_n := jsonb_array_length(coalesce(v_tax -> 'brackets', '[]'::jsonb));
        if coalesce((v_tax ->> 'enabled')::boolean, false) and v_n = 0 then raise exception 'THE TAX TABLE NEEDS AT LEAST ONE BRACKET'; end if;
        for v_b in select value from jsonb_array_elements(coalesce(v_tax -> 'brackets', '[]'::jsonb)) loop
            v_i := v_i + 1;
            if coalesce((v_b ->> 'rate')::numeric, -1) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;
            if v_i < v_n and ((v_b ->> 'upTo') is null or (v_b ->> 'upTo')::numeric <= v_prev) then raise exception 'THE BRACKETS MUST RISE IN ORDER'; end if;
            if v_i = v_n and (v_b ->> 'upTo') is not null then raise exception 'THE LAST BRACKET HAS NO UPPER LIMIT'; end if;
            v_prev := coalesce((v_b ->> 'upTo')::numeric, v_prev);
        end loop;
        for v_b in select value from jsonb_array_elements(coalesce(v_tax -> 'tiers', '[]'::jsonb)) loop
            if (v_b ->> 'startBracket')::integer not between 0 and greatest(v_n - 1, 0) or (v_b ->> 'above')::numeric < 0 then raise exception 'INVALID HIGH-INCOME TIER'; end if;
        end loop;
        if coalesce((v_tax ->> 'personalExemption')::numeric, 0) < 0 then raise exception 'INVALID PERSONAL EXEMPTION'; end if;
    end if;
    if v_fund is not null and coalesce((v_fund ->> 'rate')::numeric, 0) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;

    update payroll_settings set statutory = p_config, updated_by = public.current_prosm_time_user_id(), updated_at = now() where organization_id = v_org;
    perform public.prosm_time_payroll_log(v_org, 'PAYROLL_STATUTORY_CHANGED', 'payroll_settings', v_org, null, 'Changed the insurance and tax rules', null, jsonb_build_object('config', p_config));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.save_prosm_time_payroll_statutory(jsonb) from public, anon;
grant execute on function public.save_prosm_time_payroll_statutory(jsonb) to authenticated;

create or replace function public.reset_prosm_time_payroll_statutory(p_country_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_config jsonb;
begin
    perform public.prosm_time_payroll_require('payroll.manage_settings', null);
    select config into v_config from payroll_country_packs where code = upper(coalesce(p_country_code, ''));
    if v_config is null then raise exception 'COUNTRY NOT FOUND'; end if;
    update payroll_settings set country_code = upper(p_country_code), statutory = v_config, updated_by = public.current_prosm_time_user_id(), updated_at = now()
    where organization_id = v_org;
    perform public.prosm_time_payroll_log(v_org, 'PAYROLL_STATUTORY_RESET', 'payroll_settings', v_org, null, 'Insurance and tax rules set to the country''s values', null,
                                          jsonb_build_object('country', upper(p_country_code)));
    return jsonb_build_object('success', true, 'config', v_config);
end;
$$;
revoke all on function public.reset_prosm_time_payroll_statutory(text) from public, anon;
grant execute on function public.reset_prosm_time_payroll_statutory(text) to authenticated;

-- statutory lines are computed, never edited or deleted by hand (the rules and the profile decide)
do $patch$
declare
    v_fn text;
    v_def text;
begin
    foreach v_fn in array array['public.save_prosm_time_payroll_line', 'public.delete_prosm_time_payroll_line'] loop
        select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.oid = (select min(oid) from pg_proc where oid::regprocedure::text like replace(v_fn, 'public.', '') || '(%');
        if v_def is null or position('if v_line.source in (''fixed'', ''installment'') then' in v_def) = 0 then raise exception 'line guard anchor not found in %', v_fn; end if;
        v_def := replace(v_def, 'if v_line.source in (''fixed'', ''installment'') then', 'if v_line.source in (''fixed'', ''installment'', ''statutory'') then');
        execute v_def;
    end loop;
end;
$patch$;

commit;
