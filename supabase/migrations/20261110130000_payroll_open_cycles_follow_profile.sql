-- 2026-11-10 (owner): "I added earnings and deductions to the salary card, but they did not appear in
-- the payslip". A cycle takes the salary items from the person's file when it is created (or when
-- "recalculate" is pressed), so items added later stayed out of a cycle already open.
-- Now a change to a person's salary file (an item's value, or the file itself) rebuilds that person in
-- every OPEN cycle (draft or reopened) at once. Approved and locked cycles never change - their
-- payslips are the approved copy, as before (reopen with a reason to change them).
-- Rollback: drop the two triggers and prosm_time_payroll_follow_profile().

begin;

create or replace function public.prosm_time_payroll_follow_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user uuid;
    v_ce record;
begin
    -- (each table's own column: a CASE would read both)
    if tg_table_name = 'payroll_profiles' then
        v_user := new.user_id;
    else
        select user_id into v_user from payroll_profiles where id = new.profile_id;
    end if;
    if v_user is null then return new; end if;
    for v_ce in
        select ce.id, ce.cycle_id
        from payroll_cycle_employees ce
        join payroll_cycles c on c.id = ce.cycle_id
        where ce.user_id = v_user and c.status in ('draft', 'reopened')
    loop
        perform public.prosm_time_payroll_build_employee(v_ce.id);
        update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = v_ce.cycle_id;
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_follow_profile() from public, anon, authenticated;

drop trigger if exists payroll_profile_components_follow on public.payroll_profile_components;
create trigger payroll_profile_components_follow
after insert or update on public.payroll_profile_components
for each row execute function public.prosm_time_payroll_follow_profile();

drop trigger if exists payroll_profiles_follow on public.payroll_profiles;
create trigger payroll_profiles_follow
after update on public.payroll_profiles
for each row execute function public.prosm_time_payroll_follow_profile();

commit;
