-- 2026-11-09 payroll usability (spec 15.14):
--   * copy the variable lines of each person's previous cycle into this one, as drafts to edit;
--   * add the same line to several chosen people in one step (all or nothing).
-- Both go through save_prosm_time_payroll_line, so every rule stays in one place: the caller's
-- payroll scope per person, an editable cycle, variable amount components only, recalculation,
-- the cycle's row version and the action log.

begin;

create or replace function public.copy_prosm_time_payroll_variables(p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype;
    v_row record;
    v_copied integer := 0;
    v_skipped integer := 0;
begin
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null then raise exception 'PAYROLL CYCLE NOT FOUND'; end if;
    perform public.prosm_time_payroll_require_editable(v_cycle);
    for v_row in
        select ce.id as cycle_employee_id, ce.site_id, l.id as from_line, l.component_id, l.raw_amount, l.notes,
               exists (select 1 from payroll_cycle_lines x where x.cycle_employee_id = ce.id and x.component_id = l.component_id) as already
        from payroll_cycle_employees ce
        cross join lateral (
            -- the person's latest earlier cycle that was not cancelled
            select pce.id from payroll_cycle_employees pce join payroll_cycles pc on pc.id = pce.cycle_id
            where pce.user_id = ce.user_id and pc.organization_id = v_cycle.organization_id and pc.id <> v_cycle.id
              and pc.period_end < v_cycle.period_start and pc.status <> 'cancelled'
            order by pc.period_end desc limit 1
        ) prev
        join payroll_cycle_lines l on l.cycle_employee_id = prev.id and l.source in ('variable', 'import')
        join payroll_components c on c.id = l.component_id and c.is_active and c.source = 'variable' and c.calc_type = 'amount'
        where ce.cycle_id = v_cycle.id
          and public.prosm_time_payroll_allows('payroll.enter_monthly_variables', ce.site_id)
    loop
        if v_row.already then
            v_skipped := v_skipped + 1;
            continue;
        end if;
        perform public.save_prosm_time_payroll_line(v_row.cycle_employee_id, null, v_row.component_id, v_row.raw_amount, v_row.notes,
                                                    null, 'variable', jsonb_build_object('copiedFrom', v_row.from_line));
        v_copied := v_copied + 1;
    end loop;
    return jsonb_build_object('success', true, 'copied', v_copied, 'skipped', v_skipped);
end;
$$;
revoke all on function public.copy_prosm_time_payroll_variables(uuid) from public, anon;
grant execute on function public.copy_prosm_time_payroll_variables(uuid) to authenticated;

create or replace function public.add_prosm_time_payroll_line_bulk(p_cycle_id uuid, p_cycle_employee_ids uuid[], p_component_id uuid, p_amount numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_count integer := 0;
begin
    if coalesce(cardinality(p_cycle_employee_ids), 0) = 0 then raise exception 'CHOOSE AT LEAST ONE PERSON'; end if;
    if cardinality(p_cycle_employee_ids) > 2000 then raise exception 'TOO MANY PEOPLE AT ONCE'; end if;
    foreach v_id in array (select array_agg(distinct x) from unnest(p_cycle_employee_ids) x) loop
        if not exists (select 1 from payroll_cycle_employees where id = v_id and cycle_id = p_cycle_id) then
            raise exception 'EMPLOYEE NOT IN THIS CYCLE';
        end if;
        perform public.save_prosm_time_payroll_line(v_id, null, p_component_id, p_amount, p_notes, null, 'variable', jsonb_build_object('bulk', true));
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'added', v_count);
end;
$$;
revoke all on function public.add_prosm_time_payroll_line_bulk(uuid, uuid[], uuid, numeric, text) from public, anon;
grant execute on function public.add_prosm_time_payroll_line_bulk(uuid, uuid[], uuid, numeric, text) to authenticated;

commit;
