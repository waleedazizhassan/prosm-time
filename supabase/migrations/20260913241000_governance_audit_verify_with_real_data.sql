-- PROSM Time - the org has 0 real projects today, so
-- 20260913240000's counts couldn't actually prove the new scoping is
-- correct, only that it no longer crashes. This inserts 2 temporary
-- projects (one at Uu's real managed site العجمي, one at a different
-- real site) and one temporary project_assignments row, runs the same
-- 3-account simulation against them, then ROLLS BACK - nothing here
-- is ever committed to the real database.

begin;

do $$
declare
    v_owner_auth_id uuid;
    v_manager_auth_id uuid;
    v_employee_auth_id uuid;
    v_org uuid;
    v_managed_site uuid;
    v_other_site uuid;
    v_managed_project uuid;
    v_other_project uuid;
    v_count int;
begin
    select auth_user_id, organization_id into v_owner_auth_id, v_org from users where email = 'admin@prosm.net';
    select auth_user_id into v_manager_auth_id from users where email = 'eaya4340@gmail.com';
    select auth_user_id into v_employee_auth_id from users where email = 'waleedaziz144@yahoo.com';

    select sa.site_id into v_managed_site
    from site_assignments sa
    join users u on u.id = sa.user_id
    where u.email = 'eaya4340@gmail.com' and sa.role_at_site = 'manager'
    limit 1;

    select id into v_other_site from sites where organization_id = v_org and id <> v_managed_site limit 1;

    if v_managed_site is null or v_other_site is null then
        raise notice 'SKIPPED - need at least 2 real sites in the org (one managed by Uu, one not) to run this test.';
        return;
    end if;

    insert into projects (site_id, name) values (v_managed_site, '__audit_test_managed__') returning id into v_managed_project;
    insert into projects (site_id, name) values (v_other_site, '__audit_test_other__') returning id into v_other_project;
    insert into project_assignments (project_id, user_id, assigned_by)
    select v_other_project, u.id, u.id from users u where u.email = 'waleedaziz144@yahoo.com';

    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects where id in (v_managed_project, v_other_project);
    raise notice 'OWNER sees % of 2 test projects (expect: 2)', v_count;
    reset role;

    perform set_config('request.jwt.claim.sub', v_manager_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects where id = v_managed_project;
    raise notice 'MANAGER (Uu) sees her own managed-site test project: % (expect: 1)', v_count;
    select count(*) into v_count from projects where id = v_other_project;
    raise notice 'MANAGER (Uu) sees the OTHER site''s test project: % (expect: 0)', v_count;
    select count(*) into v_count from project_assignments where project_id = v_other_project;
    raise notice 'MANAGER (Uu) sees the OTHER site''s test project_assignments row: % (expect: 0)', v_count;
    reset role;

    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects where id = v_other_project;
    raise notice 'EMPLOYEE (Lido) sees the test project she is personally assigned to: % (expect: 1)', v_count;
    select count(*) into v_count from projects where id = v_managed_project;
    raise notice 'EMPLOYEE (Lido) sees the test project she is NOT assigned to: % (expect: 0)', v_count;
    reset role;
end $$;

rollback;
