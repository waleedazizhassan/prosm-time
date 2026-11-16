-- Owner 2026-11-16 (tested in Ratomag: "I gave the HR manager authority, then gave it to someone else, and it was
-- accepted"). Chosen: it MOVES - and "the same for every administration": finance, HR, attendance, sites, reports,
-- media (the permission sets of the person page, PermissionBundles.tsx - kept identical here).
-- Rule: whoever comes to hold a set's every permission becomes that administration's manager; anyone else who held
-- the whole set with at least part of it GIVEN to them (on top of their role) loses what was given from that set's
-- own permissions. Permissions shared with another set (reports.view, timesheets.approve, ...) and those a role
-- brings stay - moving finance never breaks someone's HR or site work, and a role is never cut down. The owner keeps
-- everything. Audited per person as MANAGEMENT_MOVED. A trigger on the grant itself, so every screen obeys it.
-- Rollback: drop trigger user_permission_overrides_management_single and the functions below.

begin;

create or replace function public.prosm_time_management_sets()
returns table (set_key text, keys text[])
language sql
immutable
as $$
    values
    ('finance', array['payroll.access', 'payroll.view', 'payroll.view_cost', 'payroll.edit_draft', 'payroll.enter_monthly_variables', 'payroll.review',
                      'payroll.approve', 'payroll.reopen', 'payroll.publish_payslips', 'payroll.export_payslips', 'payroll.export_summary',
                      'payroll.export_combined_allowances', 'payroll.import', 'payroll.manage_profiles', 'payroll.manage_installments',
                      'payroll.manage_settings', 'payroll.view_audit_log', 'allowances.view', 'allowances.approve', 'external_labor.view_pay',
                      'external_labor.approve', 'external_labor.export', 'reports.view', 'reports.export']),
    ('hr', array['hr.manage', 'employees.view', 'employees.create', 'employees.edit', 'leave.approve', 'leave.manage_types', 'leave.set_deduction',
                 'departments.manage', 'timesheets.approve', 'announcements.publish', 'reports.view']),
    ('attendance', array['attendance.view', 'attendance.correct', 'attendance.manage_permissions', 'attendance.clock_in_on_behalf',
                         'attendance.clock_out_on_behalf', 'attendance.review_integrity_flags', 'exceptions.manage', 'sessions.review_pending',
                         'timesheets.generate', 'timesheets.approve', 'sos.acknowledge']),
    ('sites', array['sites.manage', 'sites.manage_exit_policy', 'sites.manage_integrity', 'gps_settings.manage', 'schedules.manage', 'calendar.manage',
                    'external_labor.view', 'external_labor.manage']),
    ('reports', array['dashboard.view', 'reports.view', 'reports.generate_pdf', 'reports.export', 'audit.view']),
    ('media', array['announcements.publish', 'announcements.manage', 'announcements.view_reads'])
$$;

-- a set's own permissions: those no other set has (only these move)
create or replace function public.prosm_time_management_own_keys(p_set text)
returns text[]
language sql
immutable
as $$
    select coalesce(array_agg(k), array[]::text[]) from (
        select unnest(keys) k from public.prosm_time_management_sets() where set_key = p_set
        except
        select unnest(keys) from public.prosm_time_management_sets() where set_key <> p_set
    ) x;
$$;

-- holds every permission of the set (those that exist in the catalogue)
create or replace function public.prosm_time_holds_management_set(p_user uuid, p_set text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select not exists (
        select 1 from public.prosm_time_management_sets() s cross join unnest(s.keys) k
        join permissions p on p.permission_key = k
        where s.set_key = p_set and not public.prosm_time_user_has_permission_internal(p_user, k)
    );
$$;
revoke all on function public.prosm_time_holds_management_set(uuid, text) from public, anon, authenticated;

-- the current managers of a set (the owner aside): the whole set, part of it given on top of the role
create or replace function public.prosm_time_management_holders(p_org uuid, p_set text, p_except uuid)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
    select u.id, u.full_name from users u
    where u.organization_id = p_org and u.is_active and not u.is_owner and u.id is distinct from p_except
      and exists (select 1 from user_permission_overrides o join permissions p on p.id = o.permission_id
                  where o.user_id = u.id and o.is_granted and p.permission_key = any(public.prosm_time_management_own_keys(p_set)))
      and public.prosm_time_holds_management_set(u.id, p_set)
    order by u.full_name;
$$;
revoke all on function public.prosm_time_management_holders(uuid, text, uuid) from public, anon, authenticated;

-- for the confirmation before giving a set: who manages it now
create or replace function public.list_prosm_time_management_holders(p_set text, p_except uuid default null)
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
                     from public.prosm_time_management_holders(public.current_prosm_time_organization_id(), p_set, p_except) h), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_management_holders(text, uuid) from public, anon;
grant execute on function public.list_prosm_time_management_holders(text, uuid) to authenticated;

create or replace function public.prosm_time_management_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_key text;
    v_set text;
    v_holder record;
    v_actor uuid := coalesce(public.current_prosm_time_user_id(), new.granted_by);
begin
    if not new.is_granted then return new; end if;
    if exists (select 1 from users where id = new.user_id and is_owner) then return new; end if;
    select permission_key into v_key from permissions where id = new.permission_id;
    select organization_id into v_org from users where id = new.user_id;
    for v_set in select set_key from public.prosm_time_management_sets() where v_key = any(keys) loop
        -- this grant made the person the set's manager?
        if not public.prosm_time_holds_management_set(new.user_id, v_set) then continue; end if;
        perform pg_advisory_xact_lock(hashtextextended('prosm_time_management:' || v_org::text || ':' || v_set, 0));
        for v_holder in select * from public.prosm_time_management_holders(v_org, v_set, new.user_id) loop
            delete from user_permission_overrides o using permissions p
            where o.user_id = v_holder.id and o.is_granted and p.id = o.permission_id
              and p.permission_key = any(public.prosm_time_management_own_keys(v_set));
            insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
            values (v_org, v_actor, v_holder.id, 'MANAGEMENT_MOVED', 'users', v_holder.id, 'An administration''s authority moved to another person',
                    jsonb_build_object('set', v_set, 'holder', v_holder.id), jsonb_build_object('set', v_set, 'holder', new.user_id));
        end loop;
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_management_move() from public, anon, authenticated;

drop trigger if exists user_permission_overrides_management_single on public.user_permission_overrides;
create trigger user_permission_overrides_management_single
    after insert or update of is_granted on public.user_permission_overrides
    for each row execute function public.prosm_time_management_move();

commit;
