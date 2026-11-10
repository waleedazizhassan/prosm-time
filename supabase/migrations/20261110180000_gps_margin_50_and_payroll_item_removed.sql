-- 2026-11-10 (owner):
-- 1. "Make the default GPS margin 50 m, and any margin of 500 make it 50" - the organisation's default for
--    new sites and every site whose margin is 500 m are set to 50 m (the column defaults are already 50).
--    Other values are not touched; each site can still be changed in its settings.
-- 2. An item removed from ONE employee's salary card ends for that person only. When its value started
--    on the same date it is removed from, the row is deleted - the open cycles now follow a delete too
--    (before, only an insert or an update rebuilt them). Ending an amount item (no amount, no percent)
--    was refused as "INVALID AMOUNT" - it now ends the item, as the function always meant to.
-- Rollback: the margins cannot be told apart afterwards (500 -> 50 is one-way); recreate the trigger
-- payroll_profile_components_follow as "after insert or update" and the function from 20261110130000.

begin;

update public.organization_settings set default_gps_accuracy_tolerance_meters = 50 where default_gps_accuracy_tolerance_meters = 500;
update public.sites set gps_accuracy_tolerance_meters = 50 where gps_accuracy_tolerance_meters = 500;

do $patch$
declare
    v_def text := pg_get_functiondef('public.set_prosm_time_payroll_profile_component(uuid,uuid,numeric,numeric,date)'::regprocedure);
    a text := 'if v_component.calc_type = ''amount'' and (p_amount is null or p_amount < 0) then raise exception ''INVALID AMOUNT''; end if;';
begin
    if position(a in v_def) = 0 then raise exception 'amount check anchor not found'; end if;
    v_def := replace(v_def, a, 'if v_component.calc_type = ''amount'' and ((p_amount is null and p_percent is not null) or p_amount < 0) then raise exception ''INVALID AMOUNT''; end if;');
    execute v_def;
end;
$patch$;

create or replace function public.prosm_time_payroll_follow_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user uuid;
    v_profile uuid;
    v_ce record;
begin
    -- (each table's own column: a CASE would read both; a delete has only the old row)
    if tg_table_name = 'payroll_profiles' then
        v_user := new.user_id;
    else
        v_profile := case when tg_op = 'DELETE' then old.profile_id else new.profile_id end;
        select user_id into v_user from payroll_profiles where id = v_profile;
    end if;
    if v_user is null then return coalesce(new, old); end if;
    for v_ce in
        select ce.id, ce.cycle_id
        from payroll_cycle_employees ce
        join payroll_cycles c on c.id = ce.cycle_id
        where ce.user_id = v_user and c.status in ('draft', 'reopened')
    loop
        perform public.prosm_time_payroll_build_employee(v_ce.id);
        update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = v_ce.cycle_id;
    end loop;
    return coalesce(new, old);
end;
$$;
revoke all on function public.prosm_time_payroll_follow_profile() from public, anon, authenticated;

drop trigger if exists payroll_profile_components_follow on public.payroll_profile_components;
create trigger payroll_profile_components_follow
after insert or update or delete on public.payroll_profile_components
for each row execute function public.prosm_time_payroll_follow_profile();

commit;
