-- 2026-11-09 (owner's real payslip test, Ratomag, July 2026): everything matched except the salary tax
-- (2,386.10 against 2,287.00). The payslip takes health insurance and the union fee off the taxable pay
-- before the tax, and rounds the monthly tax down to the whole pound:
--   (17,868 - 487.47 - 6) x 12 - 20,000 = 188,494.36 -> 27,448.87 / 12 = 2,287.41 -> 2,287.00.
-- So:
--   * a deduction component can be "taken off before tax" (pre_tax); the taxable pay is the taxable
--     earnings less these deductions (and less the employee's insurance, as before);
--   * the tax table can round the monthly tax down to a whole unit (incomeTax.roundDown).
-- Cycles keep their snapshot as before; lines carry pre_tax from their component.
-- Rollback: drop the pre_tax columns; restore prosm_time_payroll_recalc_employee's taxable sum and
-- tax line from 20261109240000.

begin;

alter table public.payroll_components add column if not exists pre_tax boolean not null default false;
alter table public.payroll_cycle_lines add column if not exists pre_tax boolean not null default false;

create or replace function public.prosm_time_payroll_line_flags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.component_id is not null and new.source <> 'statutory' then
        select c.taxable, c.insurable, c.pre_tax into new.taxable, new.insurable, new.pre_tax from payroll_components c where c.id = new.component_id;
        new.taxable := coalesce(new.taxable, true);
        new.insurable := coalesce(new.insurable, false);
        new.pre_tax := coalesce(new.pre_tax, false);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_line_flags() from public, anon, authenticated;

do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_payroll_recalc_employee(uuid)'::regprocedure);
    a1 text := '               coalesce(sum(amount) filter (where category in (''earning'', ''allowance'') and include_in_net and taxable), 0),';
    a2 text := '            v_tax := round(public.prosm_time_payroll_income_tax(v_annual, v_sec) / 12, 2);';
begin
    if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 then raise exception 'recalc anchors not found'; end if;
    v_def := replace(v_def, a1, '               coalesce(sum(amount) filter (where category in (''earning'', ''allowance'') and include_in_net and taxable), 0)
                 - coalesce(sum(amount) filter (where category = ''deduction'' and include_in_net and pre_tax and source <> ''statutory''), 0),');
    v_def := replace(v_def, a2, '            v_tax := round(public.prosm_time_payroll_income_tax(v_annual, v_sec) / 12, 2);
            if coalesce((v_sec ->> ''roundDown'')::boolean, false) then v_tax := floor(v_tax); end if;');
    execute v_def;

    v_def := pg_get_functiondef('public.save_prosm_time_payroll_component(uuid,jsonb)'::regprocedure);
    if position('            default_amount = nullif(p_component ->> ''default_amount'', '''')::numeric
        where id = v_id;' in v_def) = 0 then raise exception 'component insert anchor not found'; end if;
    v_def := replace(v_def, '            default_amount = nullif(p_component ->> ''default_amount'', '''')::numeric
        where id = v_id;', '            default_amount = nullif(p_component ->> ''default_amount'', '''')::numeric,
            pre_tax = coalesce((p_component ->> ''pre_tax'')::boolean, false)
        where id = v_id;');
    if position('            insurable = coalesce((p_component ->> ''insurable'')::boolean, insurable),' in v_def) = 0 then raise exception 'component update anchor not found'; end if;
    v_def := replace(v_def, '            insurable = coalesce((p_component ->> ''insurable'')::boolean, insurable),',
        '            insurable = coalesce((p_component ->> ''insurable'')::boolean, insurable),
            pre_tax = coalesce((p_component ->> ''pre_tax'')::boolean, pre_tax),');
    execute v_def;
end;
$patch$;

commit;
