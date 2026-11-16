-- Owner 2026-11-17 ("I made a manager an employee - the user menu changed, his file did not"): a department manager
-- must have the Manager role (20261117170000), so a role change away from manager also takes the person off managing
-- their departments (audited). The job title is personnel data and stays as written.
-- Rollback: drop trigger users_demotion_clears_department_manager and its function.
begin;
create or replace function public.prosm_time_demotion_clears_department_manager()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_dept record;
begin
    if new.role_id is not distinct from old.role_id or new.is_owner then return new; end if;
    if exists (select 1 from roles where id = new.role_id and role_key = 'manager') then return new; end if;
    for v_dept in select id from departments where manager_user_id = new.id loop
        update departments set manager_user_id = null, updated_at = now() where id = v_dept.id;
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
        values (new.organization_id, public.current_prosm_time_user_id(), new.id, 'DEPARTMENT_MANAGER_SET', 'departments', v_dept.id,
                'No longer a department manager - the role is no longer Manager',
                jsonb_build_object('managerUserId', new.id), jsonb_build_object('managerUserId', null));
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_demotion_clears_department_manager() from public, anon, authenticated;
drop trigger if exists users_demotion_clears_department_manager on public.users;
create trigger users_demotion_clears_department_manager after update of role_id on public.users
    for each row execute function public.prosm_time_demotion_clears_department_manager();
-- people already demoted before this (Ratomag): the same rule once
update public.departments d set manager_user_id = null, updated_at = now()
where d.manager_user_id is not null
  and not exists (select 1 from users u left join roles r on r.id = u.role_id where u.id = d.manager_user_id and (u.is_owner or r.role_key = 'manager'));
commit;
