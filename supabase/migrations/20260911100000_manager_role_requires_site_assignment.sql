-- § user-directed, 2026-09-11: "لما اعين مدير بدون مواقع يعامل معاملة
-- الموظف العادي الى ان اضيفه على موقع" - a person invited with
-- role_key = 'manager' but not yet assigned to any site as its manager
-- must be treated exactly like a plain Employee (no elevated
-- visibility/capability anywhere) until the Owner actually assigns
-- them to a site with role_at_site = 'manager'.
--
-- Real gap found: get_prosm_time_effective_permissions() has always
-- resolved a user's effective set purely from their ROLE (role_key's
-- static role_default_permissions bundle), never checking whether a
-- 'manager'-role person actually manages any real site. Every
-- individual RPC this session's own manager-scoping audit reviewed
-- (leave review, timesheet approval, scheduling, reports) already
-- correctly filters its DATA down to "sites I manage" - so a site-less
-- manager was never able to see or act on another site's real data.
-- But the PERMISSION KEYS themselves (exceptions.manage,
-- timesheets.approve, sites.manage, schedules.manage...) were already
-- granted the instant the role was assigned, independent of any site -
-- so a freshly-invited, not-yet-assigned manager saw Manager Console,
-- Sites (all of them, org-wide), Reports' manager-only report types
-- etc in their own Sidebar, all rendering empty rather than not
-- appearing at all. Confusing, not a data leak (every RPC behind it
-- already returned nothing for them) - but exactly the "unclear/
-- ambiguous UI" this pass was asked to eliminate.
--
-- Fix: role_default_permissions bundle resolution now intersects a
-- 'manager'-role user's bundle down to the 'employee' bundle unless
-- they hold at least one real site_assignments row with
-- role_at_site = 'manager'. Derived from the existing bundle
-- definitions (role_default_permissions itself), not a second
-- hardcoded permission list - "manager-tier" simply means "granted to
-- 'manager' but not also granted to 'employee'". Only role_key =
-- 'manager' is touched - 'supervisor' has no site-level equivalent in
-- this schema at all (site_assignments.role_at_site only ever allows
-- 'member'/'manager') and was never part of this ask. Per-admin
-- permission overrides (user_permission_overrides) are untouched by
-- this change - those are an explicit, individual admin action, not
-- part of the role bundle this fix scopes.
--
-- CREATE OR REPLACE is safe here - the function's return type (text[])
-- is unchanged, only its body.

begin;

create or replace function public.get_prosm_time_effective_permissions(p_user_id uuid default null)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target_id uuid;
    v_caller_org uuid;
    v_target_org uuid;
    v_caller_permissions text[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    v_target_id := coalesce(p_user_id, v_caller_id);

    if v_target_id <> v_caller_id then
        v_caller_org := public.current_prosm_time_organization_id();
        select organization_id into v_target_org from users where id = v_target_id;
        if v_target_org is null or v_target_org <> v_caller_org then
            raise exception 'USER NOT FOUND';
        end if;

        select array_agg(p.permission_key) into v_caller_permissions
        from role_default_permissions rdp
        join permissions p on p.id = rdp.permission_id
        join roles r on r.id = rdp.role_id
        join users u on u.role_id = rdp.role_id
        where u.id = v_caller_id
          and (
              r.role_key <> 'manager'
              or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
              or rdp.permission_id in (
                  select rdp2.permission_id
                  from role_default_permissions rdp2
                  join roles r2 on r2.id = rdp2.role_id
                  where r2.role_key = 'employee'
              )
          );

        if not (
            'administrators.manage' = any(coalesce(v_caller_permissions, array[]::text[]))
            or 'permissions.assign' = any(coalesce(v_caller_permissions, array[]::text[]))
            or public.current_prosm_time_user_is_owner()
        ) then
            raise exception 'INSUFFICIENT AUTHORITY TO VIEW ANOTHER USER''S PERMISSIONS';
        end if;
    end if;

    return (
        select array_agg(distinct permission_key) from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join roles r on r.id = rdp.role_id
            join users u on u.role_id = rdp.role_id
            where u.id = v_target_id
              and (
                  r.role_key <> 'manager'
                  or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
                  or rdp.permission_id in (
                      select rdp2.permission_id
                      from role_default_permissions rdp2
                      join roles r2 on r2.id = rdp2.role_id
                      where r2.role_key = 'employee'
                  )
              )
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = false
        ) effective
    );
exception
    when others then
        raise exception 'GET PROSM TIME EFFECTIVE PERMISSIONS FAILED: %', sqlerrm;
end;
$function$;

commit;
