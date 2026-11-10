-- 2026-11-10 (owner): "as I add items, let me delete items". An item is deleted from the salary card by
-- stopping it (is_active = false): it leaves every salary card and every OPEN cycle (draft or reopened)
-- at once; approved and locked cycles keep their approved copy, and its history stays. The basic
-- salary cannot be deleted.
-- Rollback: drop the trigger and prosm_time_payroll_follow_items(); drop the basic guard trigger.

begin;

create or replace function public.prosm_time_payroll_follow_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ce record;
begin
    if new.is_active is not distinct from old.is_active then return new; end if;
    for v_ce in
        select ce.id, ce.cycle_id
        from payroll_cycle_employees ce
        join payroll_cycles c on c.id = ce.cycle_id
        where c.organization_id = new.organization_id and c.status in ('draft', 'reopened')
    loop
        perform public.prosm_time_payroll_build_employee(v_ce.id);
    end loop;
    update payroll_cycles set row_version = row_version + 1, updated_at = now()
    where organization_id = new.organization_id and status in ('draft', 'reopened');
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_follow_items() from public, anon, authenticated;

drop trigger if exists payroll_components_follow on public.payroll_components;
create trigger payroll_components_follow
after update of is_active on public.payroll_components
for each row execute function public.prosm_time_payroll_follow_items();

-- the basic salary stays
create or replace function public.prosm_time_payroll_keep_basic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.is_basic and old.is_active and not new.is_active then
        raise exception 'THE BASIC SALARY CANNOT BE DELETED';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_keep_basic() from public, anon, authenticated;

drop trigger if exists payroll_components_keep_basic on public.payroll_components;
create trigger payroll_components_keep_basic
before update of is_active on public.payroll_components
for each row execute function public.prosm_time_payroll_keep_basic();

commit;
