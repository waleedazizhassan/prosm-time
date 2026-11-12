-- HR suite feature 4 (spec 2026-11-11, decisions with the owner): tax and insurance configuration.
--
-- * One engine for every country: prosm_time_statutory_calc(rules, input) reads a general rule document
--   (schema 2: calculation bases, an income tax with brackets, high-income tiers and a list of reliefs,
--   insurance categories -> branches -> one rule per payer with its own limits, and other levies). The
--   payroll cycle and the try-it calculator call this same function; the calculator only does not save.
--   Egypt's existing rules (schema 1, in the EG pack, the organisations' copies and every cycle snapshot)
--   are read through prosm_time_statutory_v2(), which writes them as schema 2 - the Egyptian results do
--   not change (the step 0 regression test guards every case to the piastre).
-- * Versions: every save is a new version from the first of a month; a version is never changed. A
--   cycle takes the version in force on its first day into its snapshot, with the version's id and mode,
--   so a cycle computed with company-edited rules shows "custom rules".
-- * Egypt is the default and stays editable (owner): "preset" follows PROSM's Egypt values (updated by
--   PROSM; a company whose rules equal them gets the update too); "custom" is the company's own copy. The first custom save of any country needs the
--   liability acknowledgement, recorded on the server; every save is in the action log.
-- * The country: set at first setup (missing = Egypt); a later change is the owner's only, never while
--   a cycle is open, from the first month with no cycle, confirmed by typing the country code; employees'
--   old insurance categories stay with the old cycles.
-- No legal value for any country is written here; the only rates are Egypt's, already in the EG pack.
-- Not live until the owner approves (HR suite).
--
-- Rollback: drop the trigger payroll_country_packs_follow; restore prosm_time_payroll_recalc_employee and create_prosm_time_payroll_cycle from their
-- previous definitions (20261109320000 / 20261108130000 + patches); drop payroll_tax_configs and the
-- functions *_prosm_time_tax_config*, prosm_time_statutory_*, change_prosm_time_payroll_country,
-- set_prosm_time_organization_country; drop the added columns.

begin;

-- ---------------------------------------------------------------- data
alter table public.payroll_settings add column if not exists tax_liability_acknowledged_by uuid references public.users(id) on delete set null;
alter table public.payroll_settings add column if not exists tax_liability_acknowledged_at timestamptz;
alter table public.payroll_profiles add column if not exists insurance_category text check (insurance_category is null or insurance_category ~ '^[a-z0-9_]{1,40}$');

-- a company whose rules are PROSM's values for its country gets PROSM's updates of them; one that changed
-- them (e.g. rounding the tax down) keeps its own
create or replace function public.prosm_time_country_pack_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.config is distinct from old.config then
        update payroll_settings set statutory = new.config, updated_at = now() where country_code = new.code and statutory = old.config;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_country_pack_follow() from public, anon, authenticated;
drop trigger if exists payroll_country_packs_follow on public.payroll_country_packs;
create trigger payroll_country_packs_follow after update of config on public.payroll_country_packs
for each row execute function public.prosm_time_country_pack_follow();

create table if not exists public.payroll_tax_configs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    version integer not null,
    country_code text not null check (country_code ~ '^[A-Z]{2}$'),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    mode text not null check (mode in ('preset', 'custom')),
    copied_from_preset boolean not null default false,
    rules jsonb,
    effective_from date not null check (extract(day from effective_from) = 1),
    reason text,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (organization_id, version),
    constraint payroll_tax_configs_rules check ((mode = 'preset') = (rules is null))
);
create index if not exists payroll_tax_configs_org_idx on public.payroll_tax_configs (organization_id, effective_from desc, version desc);
alter table public.payroll_tax_configs enable row level security;
revoke all on public.payroll_tax_configs from public, anon, authenticated;

create or replace function public.prosm_time_tax_configs_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    raise exception 'A SAVED TAX VERSION CANNOT BE CHANGED';
end;
$$;
revoke all on function public.prosm_time_tax_configs_immutable() from public, anon, authenticated;
drop trigger if exists payroll_tax_configs_immutable on public.payroll_tax_configs;
create trigger payroll_tax_configs_immutable before update or delete on public.payroll_tax_configs
for each row when (pg_trigger_depth() = 0) execute function public.prosm_time_tax_configs_immutable();

-- ---------------------------------------------------------------- the rule document (schema 2)
-- Egypt's rules as they are stored today (schema 1) written as the general document. Nothing is added:
-- each figure is the one the old engine read, in the same order of operations.
create or replace function public.prosm_time_statutory_v2(p_cfg jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
    v_ins jsonb := p_cfg -> 'insurance';
    v_tax jsonb := p_cfg -> 'incomeTax';
    v_fund jsonb := p_cfg -> 'martyrsFund';
    v_reliefs jsonb := '[]'::jsonb;
begin
    if p_cfg is null or p_cfg = '{}'::jsonb then return '{}'::jsonb; end if;
    if (p_cfg ->> 'schema') = '2' then return p_cfg; end if;
    if coalesce((v_tax ->> 'insuranceDeductible')::boolean, true) then
        v_reliefs := v_reliefs || jsonb_build_array(jsonb_build_object('kind', 'employee_contributions'));
    end if;
    v_reliefs := v_reliefs || jsonb_build_array(jsonb_build_object('kind', 'fixed', 'code', 'personal_exemption',
        'value', coalesce((v_tax ->> 'personalExemption')::numeric, 0)));
    return jsonb_build_object(
        'schema', 2,
        'bases', jsonb_build_array(
            jsonb_build_object('code', 'basic', 'kind', 'basic'),
            jsonb_build_object('code', 'gross', 'kind', 'gross'),
            jsonb_build_object('code', 'taxable', 'kind', 'taxable'),
            jsonb_build_object('code', 'insurable', 'kind', 'insurable')),
        'insurance', jsonb_build_object(
            'enabled', coalesce((v_ins ->> 'enabled')::boolean, false),
            'defaultCategory', 'default',
            'categories', jsonb_build_array(jsonb_build_object('code', 'default', 'branches', jsonb_build_array(jsonb_build_object(
                'code', 'social', 'useFixedWage', true,
                'baseCode', case coalesce(v_ins ->> 'base', 'basic') when 'earnings' then 'gross' when 'flagged' then 'insurable' else 'basic' end,
                'rules', jsonb_build_array(
                    jsonb_build_object('payer', 'employee', 'rate', coalesce((v_ins ->> 'employeeRate')::numeric, 0),
                        'minBase', v_ins -> 'minWage', 'maxBase', v_ins -> 'maxWage',
                        'nameAr', coalesce(v_ins ->> 'nameAr', 'التأمينات الاجتماعية'), 'nameEn', v_ins -> 'nameEn'),
                    jsonb_build_object('payer', 'employer', 'rate', coalesce((v_ins ->> 'employerRate')::numeric, 0),
                        'minBase', v_ins -> 'minWage', 'maxBase', v_ins -> 'maxWage',
                        'nameAr', coalesce(v_ins ->> 'employerNameAr', 'حصة صاحب العمل'), 'nameEn', v_ins -> 'employerNameEn'))))))),
        'incomeTax', jsonb_build_object(
            'enabled', coalesce((v_tax ->> 'enabled')::boolean, false),
            'nameAr', coalesce(v_tax ->> 'nameAr', 'ضريبة كسب العمل'), 'nameEn', v_tax -> 'nameEn',
            'baseCode', 'taxable', 'period', 'annual_div_12', 'reliefs', v_reliefs,
            'brackets', coalesce(v_tax -> 'brackets', '[]'::jsonb), 'tiers', coalesce(v_tax -> 'tiers', '[]'::jsonb),
            'roundDown', coalesce((v_tax ->> 'roundDown')::boolean, false)),
        'levies', case when v_fund is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
            'code', 'martyrs_fund', 'enabled', coalesce((v_fund ->> 'enabled')::boolean, false), 'payer', 'employee', 'baseCode', 'gross',
            'rate', coalesce((v_fund ->> 'rate')::numeric, 0),
            'nameAr', coalesce(v_fund ->> 'nameAr', 'صندوق الشهداء'), 'nameEn', v_fund -> 'nameEn')) end);
end;
$$;
revoke all on function public.prosm_time_statutory_v2(jsonb) from public, anon;
grant execute on function public.prosm_time_statutory_v2(jsonb) to authenticated;

-- a base's amount for a person (the kinds are a fixed vocabulary; the document only refers to them)
create or replace function public.prosm_time_statutory_base(p_rules jsonb, p_code text, p_in jsonb)
returns numeric
language sql
immutable
set search_path = public
as $$
    select coalesce((p_in ->> case b ->> 'kind' when 'basic' then 'basic' when 'gross' then 'gross'
                                   when 'taxable' then 'taxable' when 'insurable' then 'insurable' end)::numeric, 0)
    from jsonb_array_elements(coalesce(p_rules -> 'bases', '[]'::jsonb)) b
    where b ->> 'code' = p_code
    limit 1;
$$;
revoke all on function public.prosm_time_statutory_base(jsonb, text, jsonb) from public, anon;
grant execute on function public.prosm_time_statutory_base(jsonb, text, jsonb) to authenticated;

-- THE calculation (payroll and the calculator). Input: basic, gross, taxable (taxable earnings less the
-- items taken off before tax), insurable (earnings marked insurable), fixedInsurableWage, insuranceExempt,
-- taxExempt, category. Output: the statutory lines, in the order and with the rounding of the old engine.
create or replace function public.prosm_time_statutory_calc(p_rules jsonb, p_in jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
    v_lines jsonb := '[]'::jsonb;
    v_ins jsonb := p_rules -> 'insurance';
    v_tax jsonb := p_rules -> 'incomeTax';
    v_cat jsonb;
    v_branch jsonb;
    v_rule jsonb;
    v_levy jsonb;
    v_relief jsonb;
    v_base numeric;
    v_b numeric;
    v_amount numeric;
    v_contrib numeric := 0;
    v_amt numeric;
    v_tax_amount numeric;
    v_annual boolean;
begin
    if p_rules is null or p_rules = '{}'::jsonb then return jsonb_build_object('lines', v_lines); end if;

    -- insurance: the person's category (or the default), each branch on its own base, a rule per payer
    if coalesce((v_ins ->> 'enabled')::boolean, false) and not coalesce((p_in ->> 'insuranceExempt')::boolean, false) then
        select c into v_cat from jsonb_array_elements(coalesce(v_ins -> 'categories', '[]'::jsonb)) c where c ->> 'code' = p_in ->> 'category';
        if v_cat is null then
            select c into v_cat from jsonb_array_elements(coalesce(v_ins -> 'categories', '[]'::jsonb)) c where c ->> 'code' = v_ins ->> 'defaultCategory';
        end if;
        if v_cat is null then v_cat := v_ins -> 'categories' -> 0; end if;
        for v_branch in select x from jsonb_array_elements(coalesce(v_cat -> 'branches', '[]'::jsonb)) x loop
            v_base := case when coalesce((v_branch ->> 'useFixedWage')::boolean, true) and (p_in ->> 'fixedInsurableWage') is not null
                           then (p_in ->> 'fixedInsurableWage')::numeric
                           else public.prosm_time_statutory_base(p_rules, v_branch ->> 'baseCode', p_in) end;
            continue when coalesce(v_base, 0) <= 0;
            for v_rule in select x from jsonb_array_elements(coalesce(v_branch -> 'rules', '[]'::jsonb)) x loop
                v_b := greatest(coalesce((v_rule ->> 'minBase')::numeric, 0), least(v_base, coalesce((v_rule ->> 'maxBase')::numeric, v_base)));
                v_amount := round(v_b * coalesce((v_rule ->> 'rate')::numeric, 0) / 100, 2);
                if v_rule ->> 'payer' = 'employer' then
                    continue when coalesce((v_rule ->> 'rate')::numeric, 0) <= 0;
                    v_lines := v_lines || jsonb_build_array(jsonb_build_object('rule', 'insurance_employer', 'branch', v_branch ->> 'code', 'category', v_cat ->> 'code',
                        'payer', 'employer', 'nameAr', v_rule ->> 'nameAr', 'nameEn', v_rule ->> 'nameEn', 'calcType', 'percent', 'percent', (v_rule ->> 'rate')::numeric,
                        'base', round(v_b, 2), 'amount', v_amount, 'inNet', false, 'sort', 990));
                else
                    v_contrib := v_contrib + v_amount;
                    v_lines := v_lines || jsonb_build_array(jsonb_build_object('rule', 'insurance_employee', 'branch', v_branch ->> 'code', 'category', v_cat ->> 'code',
                        'payer', 'employee', 'nameAr', v_rule ->> 'nameAr', 'nameEn', v_rule ->> 'nameEn', 'calcType', 'percent', 'percent', (v_rule ->> 'rate')::numeric,
                        'base', round(v_b, 2), 'amount', v_amount, 'inNet', true, 'sort', 800));
                end if;
            end loop;
        end loop;
    end if;

    -- income tax: the base, less the employee's contributions (when a relief says so), over the year or
    -- the month, less the other reliefs, through the brackets (and the high-income tiers)
    v_base := public.prosm_time_statutory_base(p_rules, coalesce(v_tax ->> 'baseCode', 'taxable'), p_in);
    if coalesce((v_tax ->> 'enabled')::boolean, false) and not coalesce((p_in ->> 'taxExempt')::boolean, false) and coalesce(v_base, 0) > 0 then
        v_annual := coalesce(v_tax ->> 'period', 'annual_div_12') = 'annual_div_12';
        v_amt := v_base;
        if exists (select 1 from jsonb_array_elements(coalesce(v_tax -> 'reliefs', '[]'::jsonb)) r where r ->> 'kind' = 'employee_contributions') then
            v_amt := v_amt - v_contrib;
        end if;
        if v_annual then v_amt := v_amt * 12; end if;
        for v_relief in select x from jsonb_array_elements(coalesce(v_tax -> 'reliefs', '[]'::jsonb)) x loop
            if v_relief ->> 'kind' = 'fixed' then
                v_amt := v_amt - coalesce((v_relief ->> 'value')::numeric, 0);
            elsif v_relief ->> 'kind' = 'percent' then
                v_amt := v_amt - least(greatest(v_amt, 0) * coalesce((v_relief ->> 'value')::numeric, 0) / 100,
                                       coalesce((v_relief ->> 'cap')::numeric, greatest(v_amt, 0)));
            end if;
        end loop;
        v_tax_amount := public.prosm_time_payroll_income_tax(v_amt, v_tax);
        if v_annual then v_tax_amount := round(v_tax_amount / 12, 2); else v_tax_amount := round(v_tax_amount, 2); end if;
        if coalesce((v_tax ->> 'roundDown')::boolean, false) then v_tax_amount := floor(v_tax_amount); end if;
        if v_tax_amount > 0 then
            v_lines := v_lines || jsonb_build_array(jsonb_build_object('rule', 'income_tax', 'payer', 'employee',
                'nameAr', v_tax ->> 'nameAr', 'nameEn', v_tax ->> 'nameEn', 'calcType', 'amount', 'percent', null,
                'base', round(greatest(v_amt, 0), 2), 'amount', v_tax_amount, 'inNet', true, 'sort', 810,
                'ref', case when v_annual then jsonb_build_object('rule', 'income_tax', 'annualTaxable', round(greatest(v_amt, 0), 2))
                            else jsonb_build_object('rule', 'income_tax', 'monthlyTaxable', round(greatest(v_amt, 0), 2)) end));
        end if;
    end if;

    -- other levies (a share of a base), e.g. Egypt's martyrs' fund
    for v_levy in select x from jsonb_array_elements(coalesce(p_rules -> 'levies', '[]'::jsonb)) x loop
        continue when not coalesce((v_levy ->> 'enabled')::boolean, true) or coalesce((v_levy ->> 'rate')::numeric, 0) <= 0;
        v_base := public.prosm_time_statutory_base(p_rules, coalesce(v_levy ->> 'baseCode', 'gross'), p_in);
        continue when coalesce(v_base, 0) <= 0;
        v_amount := round(v_base * (v_levy ->> 'rate')::numeric / 100, 2);
        continue when v_amount <= 0;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object('rule', coalesce(v_levy ->> 'code', 'levy'), 'payer', coalesce(v_levy ->> 'payer', 'employee'),
            'nameAr', v_levy ->> 'nameAr', 'nameEn', v_levy ->> 'nameEn', 'calcType', 'percent', 'percent', (v_levy ->> 'rate')::numeric,
            'base', round(v_base, 2), 'amount', v_amount, 'inNet', coalesce(v_levy ->> 'payer', 'employee') = 'employee',
            'sort', case when coalesce(v_levy ->> 'payer', 'employee') = 'employee' then 820 else 995 end));
    end loop;

    return jsonb_build_object('lines', v_lines, 'employeeContributions', v_contrib);
end;
$$;
revoke all on function public.prosm_time_statutory_calc(jsonb, jsonb) from public, anon;
grant execute on function public.prosm_time_statutory_calc(jsonb, jsonb) to authenticated;

-- the payroll uses it: step 3 of the recalculation now asks the one engine for the lines
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.prosm_time_payroll_recalc_employee(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    v_from integer;
    v_to integer;
begin
    v_from := position('    -- 3. statutory lines' in v_def);
    v_to := position('    -- 4. totals' in v_def);
    if v_from = 0 or v_to = 0 or v_to < v_from then raise exception 'recalc statutory anchors not found'; end if;
    v_def := substr(v_def, 1, v_from - 1) || '    -- 3. statutory lines (2026-11-11: one engine for every country, prosm_time_statutory_calc), from the
    -- cycle''s own snapshot of the rules; Egypt''s stored rules are read as the general document
    delete from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and source = ''statutory'';
    select policy_snapshot -> ''statutory'' into v_cfg from payroll_cycles where id = v_ce.cycle_id;
    select * into v_profile from payroll_profiles where user_id = v_ce.user_id and organization_id = v_ce.organization_id;
    if v_cfg is not null and v_cfg <> ''{}''::jsonb and v_profile.id is not null and v_profile.is_active then
        select coalesce(sum(amount) filter (where category in (''earning'', ''allowance'') and include_in_net), 0),
               coalesce(sum(amount) filter (where category in (''earning'', ''allowance'') and include_in_net and taxable), 0)
                 - coalesce(sum(amount) filter (where category = ''deduction'' and include_in_net and pre_tax and source <> ''statutory''), 0),
               coalesce(sum(amount) filter (where category in (''earning'', ''allowance'') and include_in_net and insurable), 0)
        into v_gross, v_taxable, v_insurable
        from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id;
        for v_stat in
            select x from jsonb_array_elements(public.prosm_time_statutory_calc(public.prosm_time_statutory_v2(v_cfg), jsonb_build_object(
                ''basic'', v_basic, ''gross'', v_gross, ''taxable'', v_taxable, ''insurable'', v_insurable,
                ''fixedInsurableWage'', v_profile.insurable_wage, ''insuranceExempt'', v_profile.insurance_exempt, ''taxExempt'', v_profile.tax_exempt,
                ''category'', v_profile.insurance_category)) -> ''lines'') x
        loop
            insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, calc_type, percent, base_amount,
                                             raw_amount, amount, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
            values (v_ce.organization_id, p_cycle_employee_id, coalesce(v_stat ->> ''nameAr'', v_stat ->> ''nameEn'', v_stat ->> ''rule''), v_stat ->> ''nameEn'',
                    ''deduction'', ''statutory'', v_stat ->> ''calcType'', (v_stat ->> ''percent'')::numeric, (v_stat ->> ''base'')::numeric,
                    (v_stat ->> ''amount'')::numeric, (v_stat ->> ''amount'')::numeric, (v_stat ->> ''inNet'')::boolean, (v_stat ->> ''inNet'')::boolean,
                    (v_stat ->> ''inNet'')::boolean, false, (v_stat ->> ''sort'')::integer, false, false,
                    coalesce(v_stat -> ''ref'', jsonb_build_object(''rule'', v_stat ->> ''rule'')
                        || case when v_stat ? ''branch'' and v_stat ->> ''branch'' <> ''social'' then jsonb_build_object(''branch'', v_stat ->> ''branch'') else ''{}''::jsonb end));
        end loop;
    end if;

' || substr(v_def, v_to);
    v_def := regexp_replace(v_def, E'\ndeclare\n', E'\ndeclare\n    v_stat jsonb;\n');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- which rules a cycle takes
-- The version in force on the day (its own rules, or for "preset" the country's pack as PROSM keeps it);
-- before any version: the organisation's rules as they were (its pack, or its own changes).
create or replace function public.prosm_time_statutory_snapshot(p_org uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_c payroll_tax_configs%rowtype;
    v_s payroll_settings%rowtype;
    v_pack jsonb;
begin
    select * into v_c from payroll_tax_configs where organization_id = p_org and effective_from <= p_day order by effective_from desc, version desc limit 1;
    if v_c.id is not null then
        if v_c.mode = 'preset' then
            select config into v_pack from payroll_country_packs where code = v_c.country_code;
            return jsonb_build_object('statutory', coalesce(v_pack, '{}'::jsonb), 'statutoryMeta', jsonb_build_object(
                'configId', v_c.id, 'version', v_c.version, 'mode', 'preset', 'country', v_c.country_code, 'currency', v_c.currency));
        end if;
        return jsonb_build_object('statutory', v_c.rules, 'statutoryMeta', jsonb_build_object(
            'configId', v_c.id, 'version', v_c.version, 'mode', 'custom', 'country', v_c.country_code, 'currency', v_c.currency,
            'copiedFromPreset', v_c.copied_from_preset));
    end if;
    select * into v_s from payroll_settings where organization_id = p_org;
    select config into v_pack from payroll_country_packs where code = v_s.country_code;
    return jsonb_build_object('statutory', coalesce(v_s.statutory, '{}'::jsonb), 'statutoryMeta', jsonb_build_object(
        'mode', case when coalesce(v_s.statutory, '{}'::jsonb) = '{}'::jsonb then 'none' when v_s.statutory = v_pack then 'preset' else 'custom' end,
        'country', v_s.country_code, 'currency', v_s.default_currency));
end;
$$;
revoke all on function public.prosm_time_statutory_snapshot(uuid, date) from public, anon, authenticated;

do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.create_prosm_time_payroll_cycle(date,date,uuid,text)'::regprocedure), chr(13) || chr(10), chr(10));
    v_anchor text := 'p_period_start, p_period_end, to_jsonb(v_settings) - ''organization_id'' - ''last_export_serial'' - ''updated_by'' - ''updated_at'',';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'create cycle snapshot anchor not found'; end if;
    v_def := replace(v_def, v_anchor, 'p_period_start, p_period_end, (to_jsonb(v_settings) - ''organization_id'' - ''last_export_serial'' - ''updated_by'' - ''updated_at'')
                || public.prosm_time_statutory_snapshot(v_org, p_period_start),');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- checking a rule document
create or replace function public.prosm_time_validate_tax_rules(p_rules jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
    v_tax jsonb := p_rules -> 'incomeTax';
    v_ins jsonb := p_rules -> 'insurance';
    v_b jsonb;
    v_n integer;
    v_i integer := 0;
    v_prev numeric := 0;
    v_cat jsonb;
    v_branch jsonb;
    v_rule jsonb;
    v_codes text[] := array(select b ->> 'code' from jsonb_array_elements(coalesce(p_rules -> 'bases', '[]'::jsonb)) b);
begin
    if p_rules is null or jsonb_typeof(p_rules) <> 'object' or (p_rules ->> 'schema') is distinct from '2' then raise exception 'INVALID TAX RULES'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_rules -> 'bases', '[]'::jsonb)) b
               where b ->> 'kind' not in ('basic', 'gross', 'taxable', 'insurable') or coalesce(b ->> 'code', '') !~ '^[a-z0-9_]{1,40}$') then
        raise exception 'INVALID TAX RULES';
    end if;
    if v_tax is not null and coalesce((v_tax ->> 'enabled')::boolean, false) then
        if not (coalesce(v_tax ->> 'baseCode', 'taxable') = any(v_codes)) then raise exception 'INVALID TAX RULES'; end if;
        if coalesce(v_tax ->> 'period', 'annual_div_12') not in ('monthly', 'annual_div_12') then raise exception 'INVALID TAX RULES'; end if;
        v_n := jsonb_array_length(coalesce(v_tax -> 'brackets', '[]'::jsonb));
        if v_n = 0 then raise exception 'THE TAX TABLE NEEDS AT LEAST ONE BRACKET'; end if;
        for v_b in select value from jsonb_array_elements(v_tax -> 'brackets') loop
            v_i := v_i + 1;
            if coalesce((v_b ->> 'rate')::numeric, -1) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;
            if v_i < v_n and ((v_b ->> 'upTo') is null or (v_b ->> 'upTo')::numeric <= v_prev) then raise exception 'THE BRACKETS MUST RISE IN ORDER'; end if;
            if v_i = v_n and (v_b ->> 'upTo') is not null then raise exception 'THE LAST BRACKET HAS NO UPPER LIMIT'; end if;
            v_prev := coalesce((v_b ->> 'upTo')::numeric, v_prev);
        end loop;
        for v_b in select value from jsonb_array_elements(coalesce(v_tax -> 'tiers', '[]'::jsonb)) loop
            if (v_b ->> 'startBracket')::integer not between 0 and greatest(v_n - 1, 0) or (v_b ->> 'above')::numeric < 0 then raise exception 'INVALID HIGH-INCOME TIER'; end if;
        end loop;
        for v_b in select value from jsonb_array_elements(coalesce(v_tax -> 'reliefs', '[]'::jsonb)) loop
            if v_b ->> 'kind' not in ('employee_contributions', 'fixed', 'percent') then raise exception 'INVALID TAX RULES'; end if;
            if v_b ->> 'kind' = 'fixed' and coalesce((v_b ->> 'value')::numeric, -1) < 0 then raise exception 'INVALID PERSONAL EXEMPTION'; end if;
            if v_b ->> 'kind' = 'percent' and coalesce((v_b ->> 'value')::numeric, -1) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;
        end loop;
    end if;
    if v_ins is not null and coalesce((v_ins ->> 'enabled')::boolean, false) then
        if jsonb_array_length(coalesce(v_ins -> 'categories', '[]'::jsonb)) = 0 then raise exception 'ADD AT LEAST ONE INSURANCE CATEGORY'; end if;
        if (select count(distinct c ->> 'code') from jsonb_array_elements(v_ins -> 'categories') c) <> jsonb_array_length(v_ins -> 'categories') then
            raise exception 'EACH INSURANCE CATEGORY NEEDS ITS OWN CODE';
        end if;
        for v_cat in select value from jsonb_array_elements(v_ins -> 'categories') loop
            if coalesce(v_cat ->> 'code', '') !~ '^[a-z0-9_]{1,40}$' or length(trim(coalesce(v_cat ->> 'name', v_cat ->> 'code', ''))) = 0 then raise exception 'NAME EACH INSURANCE CATEGORY'; end if;
            for v_branch in select value from jsonb_array_elements(coalesce(v_cat -> 'branches', '[]'::jsonb)) loop
                if not (coalesce(v_branch ->> 'baseCode', '') = any(v_codes)) then raise exception 'INVALID TAX RULES'; end if;
                for v_rule in select value from jsonb_array_elements(coalesce(v_branch -> 'rules', '[]'::jsonb)) loop
                    if v_rule ->> 'payer' not in ('employee', 'employer') then raise exception 'INVALID TAX RULES'; end if;
                    if coalesce((v_rule ->> 'rate')::numeric, -1) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;
                    if (v_rule ->> 'minBase') is not null and (v_rule ->> 'minBase')::numeric < 0 then raise exception 'THE MAXIMUM INSURABLE WAGE MUST NOT BE BELOW THE MINIMUM'; end if;
                    if (v_rule ->> 'maxBase') is not null and (v_rule ->> 'maxBase')::numeric < coalesce((v_rule ->> 'minBase')::numeric, 0) then
                        raise exception 'THE MAXIMUM INSURABLE WAGE MUST NOT BE BELOW THE MINIMUM';
                    end if;
                end loop;
            end loop;
        end loop;
    end if;
    for v_b in select value from jsonb_array_elements(coalesce(p_rules -> 'levies', '[]'::jsonb)) loop
        if coalesce((v_b ->> 'rate')::numeric, -1) not between 0 and 100 then raise exception 'A RATE MUST BE BETWEEN 0 AND 100'; end if;
        if not (coalesce(v_b ->> 'baseCode', 'gross') = any(v_codes)) or coalesce(v_b ->> 'payer', 'employee') not in ('employee', 'employer') then raise exception 'INVALID TAX RULES'; end if;
    end loop;
end;
$$;
revoke all on function public.prosm_time_validate_tax_rules(jsonb) from public, anon, authenticated;

-- the first month a new version may start: this month, and after every cycle already made
create or replace function public.prosm_time_tax_next_month(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
    select greatest(date_trunc('month', (now() at time zone public.prosm_time_site_timezone(null, p_org)))::date,
                    coalesce((select (date_trunc('month', max(period_start)) + interval '1 month')::date from payroll_cycles
                              where organization_id = p_org and status <> 'cancelled'), '0001-01-01'::date));
$$;
revoke all on function public.prosm_time_tax_next_month(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- reading, trying, saving
-- who may: the owner or a personnel manager (the payroll settings permission too, as before)
create or replace function public.prosm_time_tax_config_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_is_owner() or public.prosm_time_is_hr() or public.prosm_time_payroll_allows('payroll.manage_settings', null);
$$;
revoke all on function public.prosm_time_tax_config_editor() from public, anon, authenticated;

create or replace function public.get_prosm_time_tax_config()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_s payroll_settings%rowtype;
    v_tz text := public.prosm_time_site_timezone(null, v_org);
    v_month date := date_trunc('month', (now() at time zone v_tz))::date;
    v_now jsonb;
    v_pack payroll_country_packs%rowtype;
    v_country text;
    v_categories jsonb;
begin
    perform public.prosm_time_require_feature('payroll');
    if not public.prosm_time_tax_config_editor() then raise exception 'PERMISSION DENIED'; end if;
    select * into v_s from payroll_settings where organization_id = v_org;
    v_now := public.prosm_time_statutory_snapshot(v_org, v_month);
    v_country := coalesce(v_now #>> '{statutoryMeta,country}', v_s.country_code, 'EG');
    select * into v_pack from payroll_country_packs where code = v_country;
    v_categories := public.prosm_time_statutory_v2(v_now -> 'statutory') #> '{insurance,categories}';
    return jsonb_build_object(
        'country', v_country,
        'currency', coalesce(v_now #>> '{statutoryMeta,currency}', v_s.default_currency),
        'mode', v_now #>> '{statutoryMeta,mode}',
        'version', (v_now #>> '{statutoryMeta,version}')::integer,
        'rules', public.prosm_time_statutory_v2(v_now -> 'statutory'),
        -- PROSM's own values for the country (Egypt), from the same pack the engine reads
        'official', case when v_pack.code is not null then public.prosm_time_statutory_v2(v_pack.config) end,
        'officialNote', v_pack.source_note, 'officialUpdatedAt', v_pack.updated_at,
        'matchesOfficial', v_pack.code is not null and public.prosm_time_statutory_v2(v_now -> 'statutory') = public.prosm_time_statutory_v2(v_pack.config),
        'officialChangedSince', v_pack.code is not null and v_now #>> '{statutoryMeta,mode}' = 'custom' and v_pack.updated_at > coalesce(
            (select created_at from payroll_tax_configs where id = (v_now #>> '{statutoryMeta,configId}')::uuid), v_s.updated_at),
        'liability', jsonb_build_object('at', v_s.tax_liability_acknowledged_at, 'by', (select full_name from users where id = v_s.tax_liability_acknowledged_by)),
        'isOwner', public.current_prosm_time_user_is_owner(),
        'openCycles', (select count(*) from payroll_cycles where organization_id = v_org and status in ('draft', 'in_review', 'reopened')),
        'nextFreeMonth', public.prosm_time_tax_next_month(v_org),
        'versions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'version', c.version, 'country', c.country_code, 'currency', c.currency, 'mode', c.mode,
                                'copiedFromPreset', c.copied_from_preset, 'effectiveFrom', c.effective_from, 'createdAt', c.created_at,
                                'createdBy', (select full_name from users where id = c.created_by), 'reason', c.reason) order by c.version desc)
                              from payroll_tax_configs c where c.organization_id = v_org), '[]'::jsonb),
        'packs', coalesce((select jsonb_agg(code order by code) from payroll_country_packs), '[]'::jsonb),
        -- people on payroll whose insurance category is missing (only when the rules have several categories)
        'missingCategory', case when jsonb_array_length(coalesce(v_categories, '[]'::jsonb)) > 1 then coalesce((
            select jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.full_name) order by u.full_name)
            from payroll_profiles p join users u on u.id = p.user_id
            where p.organization_id = v_org and p.is_active and u.is_active
              and (p.insurance_category is null or not exists (select 1 from jsonb_array_elements(v_categories) c where c ->> 'code' = p.insurance_category))), '[]'::jsonb)
            else '[]'::jsonb end);
end;
$$;
revoke all on function public.get_prosm_time_tax_config() from public, anon;
grant execute on function public.get_prosm_time_tax_config() to authenticated;

-- the calculator: the same engine on rules not yet saved (a draft, or the preset), nothing written
create or replace function public.preview_prosm_time_tax_config(p_rules jsonb, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rules jsonb;
    v_basic numeric := greatest(coalesce(nullif(p_input ->> 'basic', '')::numeric, 0), 0);
    v_taxable_extra numeric := greatest(coalesce(nullif(p_input ->> 'taxableAllowances', '')::numeric, 0), 0);
    v_free numeric := greatest(coalesce(nullif(p_input ->> 'nonTaxableAllowances', '')::numeric, 0), 0);
    v_pre numeric := greatest(coalesce(nullif(p_input ->> 'preTaxDeductions', '')::numeric, 0), 0);
    v_out jsonb;
    v_gross numeric;
    v_deductions numeric;
begin
    perform public.prosm_time_require_feature('payroll');
    if not public.prosm_time_tax_config_editor() then raise exception 'PERMISSION DENIED'; end if;
    if p_rules ? 'preset' then
        select public.prosm_time_statutory_v2(config) into v_rules from payroll_country_packs where code = upper(p_rules ->> 'preset');
        if v_rules is null then raise exception 'COUNTRY NOT FOUND'; end if;
    else
        perform public.prosm_time_validate_tax_rules(p_rules);
        v_rules := p_rules;
    end if;
    v_gross := v_basic + v_taxable_extra + v_free;
    v_out := public.prosm_time_statutory_calc(v_rules, jsonb_build_object(
        'basic', v_basic, 'gross', v_gross, 'taxable', v_basic + v_taxable_extra - v_pre, 'insurable', v_basic,
        'fixedInsurableWage', nullif(p_input ->> 'fixedInsurableWage', '')::numeric, 'category', p_input ->> 'category'));
    select coalesce(sum((l ->> 'amount')::numeric) filter (where (l ->> 'inNet')::boolean), 0) into v_deductions from jsonb_array_elements(v_out -> 'lines') l;
    return v_out || jsonb_build_object('gross', v_gross, 'net', v_gross - v_pre - v_deductions,
        'employerCost', (select coalesce(sum((l ->> 'amount')::numeric), 0) from jsonb_array_elements(v_out -> 'lines') l where not (l ->> 'inNet')::boolean));
end;
$$;
revoke all on function public.preview_prosm_time_tax_config(jsonb, jsonb) from public, anon;
grant execute on function public.preview_prosm_time_tax_config(jsonb, jsonb) to authenticated;


-- saving: a new version from a month. "preset" goes back to PROSM's values for the country; "custom" is
-- the company's own and needs the liability acknowledgement the first time.
create or replace function public.save_prosm_time_tax_config(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_s payroll_settings%rowtype;
    v_now jsonb;
    v_country text;
    v_mode text := coalesce(p_data ->> 'mode', 'custom');
    v_from date := nullif(p_data ->> 'effectiveFrom', '')::date;
    v_currency text := upper(coalesce(nullif(p_data ->> 'currency', ''), ''));
    v_version integer;
    v_id uuid;
begin
    perform public.prosm_time_require_feature('payroll');
    if not public.prosm_time_tax_config_editor() then raise exception 'PERMISSION DENIED'; end if;
    select * into v_s from payroll_settings where organization_id = v_org for update;
    v_now := public.prosm_time_statutory_snapshot(v_org, public.prosm_time_tax_next_month(v_org));
    v_country := coalesce(v_now #>> '{statutoryMeta,country}', v_s.country_code, 'EG');
    if v_currency = '' then v_currency := coalesce(v_now #>> '{statutoryMeta,currency}', v_s.default_currency); end if;
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'INVALID CURRENCY'; end if;
    if v_mode not in ('preset', 'custom') then raise exception 'INVALID TAX RULES'; end if;
    if v_mode = 'preset' and not exists (select 1 from payroll_country_packs where code = v_country) then raise exception 'THIS COUNTRY HAS NO READY RULES'; end if;
    if v_from is null or extract(day from v_from) <> 1 then raise exception 'THE RULES START ON THE FIRST OF A MONTH'; end if;
    if v_from < public.prosm_time_tax_next_month(v_org) then raise exception 'THE RULES CAN START ONLY AFTER THE LAST PAYROLL CYCLE'; end if;
    if v_mode = 'custom' then
        perform public.prosm_time_validate_tax_rules(p_data -> 'rules');
        if v_s.tax_liability_acknowledged_at is null then
            if not coalesce((p_data ->> 'acknowledgeLiability')::boolean, false) then raise exception 'ACKNOWLEDGE THE LIABILITY NOTICE FIRST'; end if;
            update payroll_settings set tax_liability_acknowledged_by = v_me, tax_liability_acknowledged_at = now() where organization_id = v_org;
            insert into audit_logs (organization_id, actor_user_id, action, entity_name, description)
            values (v_org, v_me, 'PAYROLL_TAX_LIABILITY_ACCEPTED', 'payroll_settings', 'Accepted that custom tax and insurance rules are the company''s responsibility');
        end if;
    end if;
    select coalesce(max(version), 0) + 1 into v_version from payroll_tax_configs where organization_id = v_org;
    insert into payroll_tax_configs (organization_id, version, country_code, currency, mode, copied_from_preset, rules, effective_from, reason, created_by)
    values (v_org, v_version, v_country, v_currency, v_mode,
            v_mode = 'custom' and coalesce((p_data ->> 'copiedFromPreset')::boolean, false),
            case when v_mode = 'custom' then p_data -> 'rules' end, v_from, nullif(trim(coalesce(p_data ->> 'reason', '')), ''), v_me)
    returning id into v_id;
    update payroll_settings set default_currency = v_currency, updated_by = v_me, updated_at = now() where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, 'PAYROLL_TAX_CONFIG_SAVED', 'payroll_tax_configs', v_id, 'Saved tax and insurance rules (version ' || v_version || ')',
            jsonb_build_object('rules', public.prosm_time_statutory_v2(v_now -> 'statutory'), 'mode', v_now #>> '{statutoryMeta,mode}'),
            jsonb_build_object('mode', v_mode, 'country', v_country, 'currency', v_currency, 'effectiveFrom', v_from, 'rules', p_data -> 'rules'));
    return jsonb_build_object('id', v_id, 'version', v_version, 'effectiveFrom', v_from);
end;
$$;
revoke all on function public.save_prosm_time_tax_config(jsonb) from public, anon;
grant execute on function public.save_prosm_time_tax_config(jsonb) to authenticated;

-- changing the country: the owner only, never with a cycle open, from the first month with no cycle,
-- confirmed by typing the new country code. Egypt (a country with ready rules) starts on them; any other
-- country starts empty, for the company to fill (with the liability acknowledgement).
create or replace function public.change_prosm_time_payroll_country(p_code text, p_confirm text, p_currency text, p_acknowledge boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_code text := upper(trim(coalesce(p_code, '')));
    v_from date;
    v_version integer;
    v_id uuid;
    v_preset boolean;
    v_old text;
begin
    perform public.prosm_time_require_feature('payroll');
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN CHANGE THE COUNTRY'; end if;
    if v_code !~ '^[A-Z]{2}$' then raise exception 'COUNTRY NOT FOUND'; end if;
    if upper(trim(coalesce(p_confirm, ''))) <> v_code then raise exception 'TYPE THE COUNTRY CODE TO CONFIRM'; end if;
    if upper(coalesce(p_currency, '')) !~ '^[A-Z]{3}$' then raise exception 'INVALID CURRENCY'; end if;
    if exists (select 1 from payroll_cycles where organization_id = v_org and status in ('draft', 'in_review', 'reopened')) then
        raise exception 'CLOSE OR CANCEL THE OPEN PAYROLL CYCLE FIRST';
    end if;
    v_old := coalesce(public.prosm_time_statutory_snapshot(v_org, public.prosm_time_tax_next_month(v_org)) #>> '{statutoryMeta,country}', 'EG');
    if v_old = v_code then raise exception 'THIS IS ALREADY THE COUNTRY'; end if;
    v_preset := exists (select 1 from payroll_country_packs where code = v_code);
    if not v_preset and (select tax_liability_acknowledged_at from payroll_settings where organization_id = v_org) is null then
        if not coalesce(p_acknowledge, false) then raise exception 'ACKNOWLEDGE THE LIABILITY NOTICE FIRST'; end if;
        update payroll_settings set tax_liability_acknowledged_by = v_me, tax_liability_acknowledged_at = now() where organization_id = v_org;
    end if;
    v_from := public.prosm_time_tax_next_month(v_org);
    select coalesce(max(version), 0) + 1 into v_version from payroll_tax_configs where organization_id = v_org;
    insert into payroll_tax_configs (organization_id, version, country_code, currency, mode, rules, effective_from, reason, created_by)
    values (v_org, v_version, v_code, upper(p_currency), case when v_preset then 'preset' else 'custom' end,
            case when v_preset then null else jsonb_build_object('schema', 2,
                'bases', jsonb_build_array(jsonb_build_object('code', 'basic', 'kind', 'basic'), jsonb_build_object('code', 'gross', 'kind', 'gross'),
                                           jsonb_build_object('code', 'taxable', 'kind', 'taxable'), jsonb_build_object('code', 'insurable', 'kind', 'insurable')),
                'insurance', jsonb_build_object('enabled', false, 'categories', '[]'::jsonb),
                'incomeTax', jsonb_build_object('enabled', false, 'baseCode', 'taxable', 'period', 'annual_div_12', 'brackets', '[]'::jsonb, 'reliefs', '[]'::jsonb, 'tiers', '[]'::jsonb),
                'levies', '[]'::jsonb) end,
            v_from, 'Country changed from ' || v_old || ' to ' || v_code, v_me)
    returning id into v_id;
    update payroll_settings set country_code = v_code, default_currency = upper(p_currency), updated_by = v_me, updated_at = now() where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, 'PAYROLL_COUNTRY_CHANGED', 'payroll_tax_configs', v_id, 'Payroll country changed',
            jsonb_build_object('country', v_old), jsonb_build_object('country', v_code, 'currency', upper(p_currency), 'from', v_from,
                'people', (select count(*) from payroll_profiles where organization_id = v_org and is_active)));
    return jsonb_build_object('id', v_id, 'effectiveFrom', v_from);
end;
$$;
revoke all on function public.change_prosm_time_payroll_country(text, text, text, boolean) from public, anon;
grant execute on function public.change_prosm_time_payroll_country(text, text, text, boolean) to authenticated;

-- the country chosen at first setup (before any payroll): Egypt's ready rules, or an empty form
create or replace function public.set_prosm_time_organization_country(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_code text := upper(trim(coalesce(p_code, '')));
    v_pack jsonb;
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN CHANGE THE COUNTRY'; end if;
    if v_code !~ '^[A-Z]{2}$' then raise exception 'COUNTRY NOT FOUND'; end if;
    if exists (select 1 from payroll_cycles where organization_id = v_org) or exists (select 1 from payroll_tax_configs where organization_id = v_org) then
        raise exception 'THE COUNTRY IS CHANGED FROM THE TAX SETTINGS';
    end if;
    select config into v_pack from payroll_country_packs where code = v_code;
    update payroll_settings set country_code = v_code, statutory = coalesce(v_pack, '{}'::jsonb),
           updated_by = public.current_prosm_time_user_id(), updated_at = now()
    where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'ORGANIZATION_COUNTRY_SET', 'payroll_settings', 'Organisation country set at first setup', jsonb_build_object('country', v_code));
    return jsonb_build_object('success', true, 'readyRules', v_pack is not null);
end;
$$;
revoke all on function public.set_prosm_time_organization_country(text) from public, anon;
grant execute on function public.set_prosm_time_organization_country(text) to authenticated;

-- a report of a cycle computed with the company's own rules says so
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.get_prosm_time_payroll_report(uuid, text, uuid[], uuid[], text)'::regprocedure), chr(13) || chr(10), chr(10));
    v_anchor text := '''showSignatures'', coalesce((v_cycle.policy_snapshot ->> ''show_signatures'')::boolean, true),';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'report settings anchor not found'; end if;
    v_def := replace(v_def, v_anchor, v_anchor || ' ''customRules'', (v_cycle.policy_snapshot #>> ''{statutoryMeta,mode}'') = ''custom'',');
    execute v_def;
end;
$patch$;

-- the insurance categories in force (for the salary card)
create or replace function public.list_prosm_time_insurance_categories()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    perform public.prosm_time_payroll_require('payroll.access', null::uuid);
    return coalesce((select jsonb_agg(jsonb_build_object('code', c ->> 'code', 'name', coalesce(c ->> 'name', c ->> 'code')))
                     from jsonb_array_elements(public.prosm_time_statutory_v2(public.prosm_time_statutory_snapshot(v_org, public.prosm_time_tax_next_month(v_org)) -> 'statutory')
                                               #> '{insurance,categories}') c), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_insurance_categories() from public, anon;
grant execute on function public.list_prosm_time_insurance_categories() to authenticated;

-- the person's insurance category, from the salary card
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.save_prosm_time_payroll_profile(uuid,jsonb)'::regprocedure), chr(13) || chr(10), chr(10));
    v_anchor text := '        tax_exempt = case when p_profile ? ''tax_exempt'' then coalesce((p_profile ->> ''tax_exempt'')::boolean, false) else tax_exempt end';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'profile anchor not found'; end if;
    v_def := replace(v_def, v_anchor, v_anchor || ',
        insurance_category = case when p_profile ? ''insurance_category'' then nullif(p_profile ->> ''insurance_category'', '''') else insurance_category end');
    execute v_def;
end;
$patch$;

commit;
