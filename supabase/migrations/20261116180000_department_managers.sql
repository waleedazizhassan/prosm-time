-- Department managers (owner 2026-11-16: "add the department managers here - e.g. the finance manager, the HR
-- manager; whoever is in this list leaves every other list - so we have department managers and site managers").
--   * departments.manager_user_id: one manager per department, an active member of the same organisation.
--   * set_prosm_time_department_manager: the owner or a departments.manage holder; audited.
--   * list_prosm_time_department_managers: who manages which department - the people list shows them in their own
--     group (and nowhere else).
-- What they may DO is unchanged here: their role and permissions as granted today. The department's own authority
-- (requests of its members) comes with phase F (docs/governance/PHASE_F_APPROVAL_MODES.md), once approved.
-- Rollback: drop the two functions and the column.

begin;

alter table public.departments add column if not exists manager_user_id uuid references public.users(id) on delete set null;
create index if not exists departments_manager_idx on public.departments (manager_user_id) where manager_user_id is not null;

create or replace function public.set_prosm_time_department_manager(p_department uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_old uuid;
begin
    if v_me is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_user_has_permission_internal(v_me, 'departments.manage')) then
        raise exception 'NOT ALLOWED TO MANAGE DEPARTMENTS';
    end if;
    select manager_user_id into v_old from departments where id = p_department and organization_id = v_org for update;
    if not found then raise exception 'DEPARTMENT NOT FOUND'; end if;
    if p_user is not null and not exists (select 1 from users where id = p_user and organization_id = v_org and is_active) then
        raise exception 'CHOOSE AN ACTIVE MEMBER OF THE ORGANIZATION';
    end if;
    update departments set manager_user_id = p_user, updated_at = now() where id = p_department;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, coalesce(p_user, v_old), 'DEPARTMENT_MANAGER_SET', 'departments', p_department, 'A department manager was set',
            jsonb_build_object('managerUserId', v_old), jsonb_build_object('managerUserId', p_user));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_department_manager(uuid, uuid) from public, anon;
grant execute on function public.set_prosm_time_department_manager(uuid, uuid) to authenticated;

create or replace function public.list_prosm_time_department_managers()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object('departmentId', d.id, 'departmentName', d.name, 'userId', d.manager_user_id) order by d.name), '[]'::jsonb)
    from departments d
    where d.organization_id = public.current_prosm_time_organization_id() and d.is_active and d.manager_user_id is not null;
$$;
revoke all on function public.list_prosm_time_department_managers() from public, anon;
grant execute on function public.list_prosm_time_department_managers() to authenticated;

commit;
