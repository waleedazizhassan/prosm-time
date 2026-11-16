-- Employee codes (owner 2026-11-16: "remove every employee code and generate them again by hiring seniority - that
-- is how the program works: each employee gets a code, by seniority, 5 sequential digits; it is generated when I add
-- the hiring date").
--   * users.employee_number: 5 digits, sequential per organisation, unique per organisation.
--   * Given automatically the moment a person has a hiring date (the next number); it then stays - a stable reference
--     for payroll, reports and papers. No hiring date, no code.
--   * Once now: every code is cleared and the organisation is numbered again by hiring date (earliest = 00001; same
--     date: who joined the app first).
--   * renumber_prosm_time_employee_codes(): the owner numbers everyone again by seniority (e.g. after entering older
--     hiring dates); audited. Approved payroll cycles keep the codes printed in them (their own snapshot).
--   * The payroll profile's code follows the person's code and is no longer typed by hand.
-- Rollback: drop the triggers users_employee_number / users_employee_number_sync / payroll_profiles_employee_code,
-- their functions, renumber_prosm_time_employee_codes, the column; re-run get_prosm_time_employee_profile from
-- 20261111200000.

begin;

alter table public.users add column if not exists employee_number text check (employee_number is null or employee_number ~ '^[0-9]{5}$');
create unique index if not exists users_employee_number_per_org on public.users (organization_id, employee_number) where employee_number is not null;

-- the next free number in the organisation (callers hold the organisation's lock)
create or replace function public.prosm_time_next_employee_number(p_org uuid)
returns text
language sql
volatile
security definer
set search_path = public
as $$
    select lpad((coalesce(max(employee_number::int), 0) + 1)::text, 5, '0') from users where organization_id = p_org and employee_number is not null;
$$;
revoke all on function public.prosm_time_next_employee_number(uuid) from public, anon, authenticated;

-- a hiring date gives the person their code
create or replace function public.prosm_time_assign_employee_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.hire_date is not null and new.employee_number is null then
        perform pg_advisory_xact_lock(hashtextextended('prosm_time_employee_number:' || new.organization_id::text, 0));
        new.employee_number := public.prosm_time_next_employee_number(new.organization_id);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_assign_employee_number() from public, anon, authenticated;
drop trigger if exists users_employee_number on public.users;
create trigger users_employee_number before insert or update of hire_date, employee_number on public.users
    for each row execute function public.prosm_time_assign_employee_number();

-- the payroll profile shows the person's code
create or replace function public.prosm_time_payroll_profile_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.employee_code := (select employee_number from users where id = new.user_id);
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_profile_code() from public, anon, authenticated;
drop trigger if exists payroll_profiles_employee_code on public.payroll_profiles;
create trigger payroll_profiles_employee_code before insert or update on public.payroll_profiles
    for each row execute function public.prosm_time_payroll_profile_code();

create or replace function public.prosm_time_sync_employee_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.employee_number is distinct from old.employee_number then
        update payroll_profiles set employee_code = new.employee_number where user_id = new.id;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_sync_employee_number() from public, anon, authenticated;
drop trigger if exists users_employee_number_sync on public.users;
create trigger users_employee_number_sync after update of employee_number on public.users
    for each row execute function public.prosm_time_sync_employee_number();

-- numbers an organisation again by seniority
create or replace function public.prosm_time_renumber_employees(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer;
begin
    perform pg_advisory_xact_lock(hashtextextended('prosm_time_employee_number:' || p_org::text, 0));
    update users set employee_number = null where organization_id = p_org and employee_number is not null;
    with ranked as (
        select id, row_number() over (order by hire_date, created_at, id) as n
        from users where organization_id = p_org and hire_date is not null
    )
    update users u set employee_number = lpad(r.n::text, 5, '0') from ranked r where u.id = r.id;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;
revoke all on function public.prosm_time_renumber_employees(uuid) from public, anon, authenticated;

create or replace function public.renumber_prosm_time_employee_codes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_count integer;
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if not exists (select 1 from users where id = v_me and is_owner) then raise exception 'ONLY THE ORGANIZATION OWNER'; end if;
    v_count := public.prosm_time_renumber_employees(v_org);
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_me, 'EMPLOYEE_CODES_RENUMBERED', 'organizations', v_org, 'Employee codes were numbered again by hiring date',
            jsonb_build_object('numbered', v_count));
    return jsonb_build_object('success', true, 'numbered', v_count);
end;
$$;
revoke all on function public.renumber_prosm_time_employee_codes() from public, anon;
grant execute on function public.renumber_prosm_time_employee_codes() to authenticated;

-- the profile shows the person's code
do $$
declare
    v_def text;
    v_old text := '(select employee_code from payroll_profiles where user_id = v_u.id)';
begin
    v_def := replace(pg_get_functiondef('public.get_prosm_time_employee_profile(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('v_u.employee_number' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'employee profile: anchor not found'; end if;
    execute replace(v_def, v_old, 'v_u.employee_number');
end $$;

-- once: every code cleared, every organisation numbered by seniority, payroll profiles follow
update payroll_profiles set employee_code = null where employee_code is not null;
do $$
declare
    v_org uuid;
begin
    for v_org in select id from organizations loop
        perform public.prosm_time_renumber_employees(v_org);
    end loop;
end $$;
update payroll_profiles p set employee_code = u.employee_number from users u where u.id = p.user_id;

commit;
