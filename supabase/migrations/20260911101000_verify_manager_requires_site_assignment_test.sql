-- Self-cleaning live verification for 20260911100000. Same technique
-- as 20260910201000 (real auth.users + users rows in an isolated test
-- org, JWT claim simulation via request.jwt.claim.sub). Confirms: a
-- fresh manager-role user with zero site assignments gets exactly the
-- employee permission bundle; assigning them as manager on one real
-- site upgrades them to the full manager bundle; assigning the SAME
-- person as manager on a SECOND site too (multi-site manager) works
-- with no conflict and keeps the full bundle.

delete from site_assignments where user_id in (select id from users where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE'));
delete from users where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from auth.users where email = 'audit-mgr-nosite@test.local';
delete from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from organization_settings where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from organizations where organization_code = 'AUDIT-MGR-NOSITE';

do $$
declare
    v_org uuid;
    v_site_a uuid;
    v_site_b uuid;
    v_mgr_auth uuid := gen_random_uuid();
    v_mgr_id uuid;
    v_manager_role_id uuid;
    v_employee_role_id uuid;
    v_employee_bundle text[];
    v_manager_bundle text[];
    v_effective text[];
begin
    select id into v_manager_role_id from roles where role_key = 'manager';
    select id into v_employee_role_id from roles where role_key = 'employee';

    select array_agg(p.permission_key order by p.permission_key) into v_employee_bundle
    from role_default_permissions rdp join permissions p on p.id = rdp.permission_id
    where rdp.role_id = v_employee_role_id;

    select array_agg(p.permission_key order by p.permission_key) into v_manager_bundle
    from role_default_permissions rdp join permissions p on p.id = rdp.permission_id
    where rdp.role_id = v_manager_role_id;

    insert into organizations (organization_code, name) values ('AUDIT-MGR-NOSITE', 'Audit Manager No-Site Org') returning id into v_org;
    insert into organization_settings (organization_id) values (v_org);

    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site A', 30.0444, 31.2357) returning id into v_site_a;
    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site B', 31.2001, 29.9187) returning id into v_site_b;

    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_mgr_auth, 'authenticated', 'authenticated', 'audit-mgr-nosite@test.local', 'x', now(), now(), now());

    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_mgr_auth, v_org, v_manager_role_id, 'audit-mgr-nosite@test.local', 'Audit Manager No Site', 'active', false)
    returning id into v_mgr_id;

    -- Step 1: manager role, zero site assignments.
    perform set_config('request.jwt.claim.sub', v_mgr_auth::text, true);
    v_effective := public.get_prosm_time_effective_permissions();
    perform set_config('request.jwt.claim.sub', '', true);

    if v_effective is distinct from v_employee_bundle then
        raise exception 'FAIL: site-less manager effective permissions % do not equal employee bundle %', v_effective, v_employee_bundle;
    end if;
    raise notice 'PASS: site-less manager permissions exactly match the employee bundle (%).', v_effective;

    -- Step 2: assign as manager on Site A.
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_a, v_mgr_id, 'manager');

    perform set_config('request.jwt.claim.sub', v_mgr_auth::text, true);
    v_effective := public.get_prosm_time_effective_permissions();
    perform set_config('request.jwt.claim.sub', '', true);

    if v_effective is distinct from v_manager_bundle then
        raise exception 'FAIL: single-site manager effective permissions % do not equal full manager bundle %', v_effective, v_manager_bundle;
    end if;
    raise notice 'PASS: after assignment to one site as manager, full manager bundle applies (%).', v_effective;

    -- Step 3: assign the SAME person as manager on a SECOND site too.
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_b, v_mgr_id, 'manager');

    perform set_config('request.jwt.claim.sub', v_mgr_auth::text, true);
    v_effective := public.get_prosm_time_effective_permissions();
    perform set_config('request.jwt.claim.sub', '', true);

    if v_effective is distinct from v_manager_bundle then
        raise exception 'FAIL: two-site manager effective permissions % do not equal full manager bundle %', v_effective, v_manager_bundle;
    end if;

    if (select count(*) from site_assignments where user_id = v_mgr_id and role_at_site = 'manager') <> 2 then
        raise exception 'FAIL: expected exactly 2 real manager site_assignments rows for the multi-site test manager';
    end if;
    raise notice 'PASS: same person is a real manager on 2 real sites simultaneously (%), no conflict.', v_effective;
end $$;

delete from site_assignments where user_id in (select id from users where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE'));
delete from users where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from auth.users where email = 'audit-mgr-nosite@test.local';
delete from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from organization_settings where organization_id in (select id from organizations where organization_code = 'AUDIT-MGR-NOSITE');
delete from organizations where organization_code = 'AUDIT-MGR-NOSITE';
