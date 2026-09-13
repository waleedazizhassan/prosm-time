-- PROSM Time - read-only governance audit diagnostic (user-directed,
-- 2026-09-13: "review governance/permissions across all role tiers").
-- Pure reads via RAISE NOTICE - no INSERT/UPDATE/DELETE anywhere in
-- this file, nothing to roll back.

do $$
declare
    r record;
begin
    raise notice '=== ACCOUNTS ===';
    for r in
        select u.email, u.full_name, u.is_owner, u.status, ro.role_key, ro.name as role_name
        from users u
        left join roles ro on ro.id = u.role_id
        where u.email in ('admin@prosm.net', 'eaya4340@gmail.com', 'waleedaziz144@yahoo.com')
    loop
        raise notice 'email=% name=% is_owner=% status=% role_key=% role_name=%',
            r.email, r.full_name, r.is_owner, r.status, r.role_key, r.role_name;
    end loop;

    raise notice '=== SITE ASSIGNMENTS FOR THOSE 3 ===';
    for r in
        select u.email, s.name as site_name, sa.role_at_site
        from users u
        join site_assignments sa on sa.user_id = u.id
        join sites s on s.id = sa.site_id
        where u.email in ('admin@prosm.net', 'eaya4340@gmail.com', 'waleedaziz144@yahoo.com')
    loop
        raise notice 'email=% site=% role_at_site=%', r.email, r.site_name, r.role_at_site;
    end loop;

    raise notice '=== ROLES CATALOG ===';
    for r in select id, role_key, name from roles order by role_key loop
        raise notice 'role_key=% name=% id=%', r.role_key, r.name, r.id;
    end loop;

    raise notice '=== PERMISSION CATALOG BY ROLE ===';
    for r in
        select ro.role_key, string_agg(p.permission_key, ', ' order by p.permission_key) as perms
        from role_default_permissions rdp
        join roles ro on ro.id = rdp.role_id
        join permissions p on p.id = rdp.permission_id
        group by ro.role_key
        order by ro.role_key
    loop
        raise notice 'role=%: %', r.role_key, r.perms;
    end loop;

    raise notice '=== ANY PER-USER PERMISSION OVERRIDES ===';
    for r in
        select u.email, p.permission_key, upo.is_granted
        from user_permission_overrides upo
        join users u on u.id = upo.user_id
        join permissions p on p.id = upo.permission_id
    loop
        raise notice 'email=% permission=% is_granted=%', r.email, r.permission_key, r.is_granted;
    end loop;

    raise notice '=== ALL PERMISSIONS NOT ASSIGNED TO ANY ROLE (orphaned) ===';
    for r in
        select p.permission_key
        from permissions p
        where not exists (select 1 from role_default_permissions rdp where rdp.permission_id = p.id)
    loop
        raise notice 'orphaned permission=%', r.permission_key;
    end loop;
end $$;
