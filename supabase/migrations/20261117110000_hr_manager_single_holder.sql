-- Owner 2026-11-16 (tested in Ratomag): "I gave the HR manager authority, then gave it to someone else, and it was
-- accepted" - both kept it. Chosen: it MOVES. One HR manager at a time (the owner aside): giving the personnel-files
-- permission (hr.manage - the heart of the "HR manager" set) to a person takes the HR manager set away from whoever
-- held it - exactly what was given to them on top of their role (their role's own permissions stay), and hr.manage
-- itself even when a role brought it. Audited per person as HR_MANAGER_MOVED. Holds for every path (the set's
-- button, the single switch, any later screen) because it is a trigger on the grant itself.
-- The keys moved are the HR set's own ones: those shared with another set (reports, timesheets, announcements)
-- stay, so moving HR never breaks the old holder's other jobs.
-- Rollback: drop trigger user_permission_overrides_hr_single + the two functions.

begin;

create or replace function public.prosm_time_hr_manager_keys()
returns text[]
language sql
immutable
as $$
    select array['hr.manage', 'hr.approve_all_requests', 'employees.view', 'employees.create', 'employees.edit',
                 'leave.approve', 'leave.manage_types', 'leave.set_deduction', 'departments.manage'];
$$;

-- who holds the HR manager authority now (the owner aside) - for the confirmation before moving it
create or replace function public.prosm_time_hr_manager_holders(p_org uuid, p_except uuid)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
    select u.id, u.full_name from users u
    where u.organization_id = p_org and u.is_active and not u.is_owner and u.id is distinct from p_except
      and (
          exists (select 1 from user_permission_overrides o join permissions p on p.id = o.permission_id
                  where o.user_id = u.id and o.is_granted and p.permission_key = 'hr.manage')
          or (
              exists (select 1 from role_default_permissions rd join permissions p on p.id = rd.permission_id
                      where rd.role_id = u.role_id and p.permission_key = 'hr.manage')
              and not exists (select 1 from user_permission_overrides o join permissions p on p.id = o.permission_id
                              where o.user_id = u.id and not o.is_granted and p.permission_key = 'hr.manage')
          )
      )
    order by u.full_name;
$$;
revoke all on function public.prosm_time_hr_manager_holders(uuid, uuid) from public, anon, authenticated;

create or replace function public.list_prosm_time_hr_manager_holders(p_except uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_user_has_permission_internal(v_me, 'permissions.assign')) then
        raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED';
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.full_name))
                     from public.prosm_time_hr_manager_holders(public.current_prosm_time_organization_id(), p_except) h), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_hr_manager_holders(uuid) from public, anon;
grant execute on function public.list_prosm_time_hr_manager_holders(uuid) to authenticated;

create or replace function public.prosm_time_hr_manager_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_holder record;
    v_hr uuid;
    v_actor uuid := coalesce(public.current_prosm_time_user_id(), new.granted_by);
begin
    if not new.is_granted then return new; end if;
    select id into v_hr from permissions where permission_key = 'hr.manage';
    if new.permission_id is distinct from v_hr then return new; end if;
    select organization_id into v_org from users where id = new.user_id;
    -- the new holder being the owner moves nothing (the owner always has it)
    if exists (select 1 from users where id = new.user_id and is_owner) then return new; end if;
    perform pg_advisory_xact_lock(hashtextextended('prosm_time_hr_manager:' || v_org::text, 0));
    for v_holder in select * from public.prosm_time_hr_manager_holders(v_org, new.user_id) loop
        -- what was given to them on top of their role, within the HR set, goes
        delete from user_permission_overrides o using permissions p
        where o.user_id = v_holder.id and o.is_granted and p.id = o.permission_id
          and p.permission_key = any(public.prosm_time_hr_manager_keys());
        -- personnel files go even when their role brought them
        if exists (select 1 from users u join role_default_permissions rd on rd.role_id = u.role_id
                   where u.id = v_holder.id and rd.permission_id = v_hr) then
            insert into user_permission_overrides (user_id, permission_id, is_granted, granted_by, reason)
            values (v_holder.id, v_hr, false, v_actor, 'HR manager moved to another person')
            on conflict (user_id, permission_id) do update set is_granted = false, granted_by = excluded.granted_by, reason = excluded.reason;
        end if;
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
        values (v_org, v_actor, v_holder.id, 'HR_MANAGER_MOVED', 'users', v_holder.id, 'The HR manager authority moved to another person',
                jsonb_build_object('holder', v_holder.id), jsonb_build_object('holder', new.user_id));
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_hr_manager_move() from public, anon, authenticated;

drop trigger if exists user_permission_overrides_hr_single on public.user_permission_overrides;
create trigger user_permission_overrides_hr_single
    after insert or update of is_granted on public.user_permission_overrides
    for each row execute function public.prosm_time_hr_manager_move();

commit;
