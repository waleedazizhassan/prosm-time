-- PROSM Time - live verification of the 3 governance fixes in
-- 20260913210000, simulated against the 3 real accounts this audit
-- was run against. SET LOCAL + SET ROLE authenticated genuinely drops
-- into the same role RLS enforces against (unlike a plain superuser
-- session, which bypasses RLS entirely) - real reads only, no writes,
-- transaction never commits any data change.

begin;

do $$
declare
    v_owner_auth_id uuid;
    v_manager_auth_id uuid;
    v_employee_auth_id uuid;
    v_count int;
    v_total_projects int;
    v_total_project_assignments int;
begin
    select auth_user_id into v_owner_auth_id from users where email = 'admin@prosm.net';
    select auth_user_id into v_manager_auth_id from users where email = 'eaya4340@gmail.com';
    select auth_user_id into v_employee_auth_id from users where email = 'waleedaziz144@yahoo.com';

    select count(*) into v_total_projects from projects p join sites s on s.id = p.site_id where s.organization_id = (select organization_id from users where email = 'admin@prosm.net');
    select count(*) into v_total_project_assignments from project_assignments pa join projects p on p.id = pa.project_id join sites s on s.id = p.site_id where s.organization_id = (select organization_id from users where email = 'admin@prosm.net');
    raise notice 'REAL ORG TOTALS: projects=% project_assignments=%', v_total_projects, v_total_project_assignments;

    -- Owner: must see every project org-wide.
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects;
    raise notice 'OWNER sees % of % projects (expect: all)', v_count, v_total_projects;
    reset role;

    -- Manager (Uu, manages site العجمي only): must see ONLY that
    -- site's projects, never another site's.
    perform set_config('request.jwt.claim.sub', v_manager_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects;
    raise notice 'MANAGER (Uu) sees % of % projects (expect: only their managed site''s, not all %)', v_count, v_total_projects, v_total_projects;
    select count(*) into v_count from project_assignments;
    raise notice 'MANAGER (Uu) sees % of % project_assignments (expect: only their managed site''s)', v_count, v_total_project_assignments;
    reset role;

    -- Employee (Lido, no site assignment at all): must see nothing
    -- beyond their own project assignments (almost certainly zero).
    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    set local role authenticated;
    select count(*) into v_count from projects;
    raise notice 'EMPLOYEE (Lido, unassigned) sees % projects (expect: 0, or only ones personally assigned to)', v_count;
    reset role;
end $$;

rollback;
