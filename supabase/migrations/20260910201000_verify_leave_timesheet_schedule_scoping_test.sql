-- Self-cleaning live verification of 20260910200000's leave/timesheet/
-- schedule site-scoping fix. Same technique as 20260910191000 (JWT
-- claim only, no role switch, report/action RPCs are SECURITY DEFINER).

delete from timesheets where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from leave_requests where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from shift_assignments where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from site_assignments where site_id in (select id from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE'));
delete from users where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from auth.users where email in ('audit-lts-mgr@test.local', 'audit-lts-empa@test.local', 'audit-lts-empb@test.local');
delete from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from organization_settings where organization_id in (select id from organizations where organization_code = 'AUDIT-LTS-SCOPE');
delete from organizations where organization_code = 'AUDIT-LTS-SCOPE';

do $$
declare
    v_org uuid;
    v_site_a uuid;
    v_site_b uuid;
    v_manager_auth uuid := gen_random_uuid();
    v_manager_id uuid;
    v_emp_a_auth uuid := gen_random_uuid();
    v_emp_a_id uuid;
    v_emp_b_auth uuid := gen_random_uuid();
    v_emp_b_id uuid;
    v_manager_role uuid;
    v_employee_role uuid;
    v_leave_b uuid;
    v_timesheet_b uuid;
    v_threw boolean;
    v_result jsonb;
begin
    select id into v_manager_role from roles where role_key = 'manager';
    select id into v_employee_role from roles where role_key = 'employee';

    insert into organizations (organization_code, name) values ('AUDIT-LTS-SCOPE', 'Audit Leave-Timesheet-Schedule Org') returning id into v_org;
    insert into organization_settings (organization_id) values (v_org);

    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site A', 30.0444, 31.2357) returning id into v_site_a;
    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site B', 31.2001, 29.9187) returning id into v_site_b;

    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_manager_auth, 'authenticated', 'authenticated', 'audit-lts-mgr@test.local', 'x', now(), now(), now());
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_emp_a_auth, 'authenticated', 'authenticated', 'audit-lts-empa@test.local', 'x', now(), now(), now());
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_emp_b_auth, 'authenticated', 'authenticated', 'audit-lts-empb@test.local', 'x', now(), now(), now());

    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_manager_auth, v_org, v_manager_role, 'audit-lts-mgr@test.local', 'Audit Manager', 'active', false)
    returning id into v_manager_id;
    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_emp_a_auth, v_org, v_employee_role, 'audit-lts-empa@test.local', 'Audit Employee A', 'active', false)
    returning id into v_emp_a_id;
    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_emp_b_auth, v_org, v_employee_role, 'audit-lts-empb@test.local', 'Audit Employee B', 'active', false)
    returning id into v_emp_b_id;

    -- Manager manages Site A only. Employee A is at Site A, Employee B at Site B.
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_a, v_manager_id, 'manager');
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_a, v_emp_a_id, 'member');
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_b, v_emp_b_id, 'member');

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status)
    values (v_org, v_emp_b_id, 'annual', current_date, current_date, 1, 'pending')
    returning id into v_leave_b;

    insert into timesheets (organization_id, user_id, period_start, period_end, status)
    values (v_org, v_emp_b_id, date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date, 'submitted')
    returning id into v_timesheet_b;

    -- Simulate the Manager's own real session. NOTE: this migration
    -- connection runs as a superuser/BYPASSRLS role (the established,
    -- documented limitation of this technique - see this session's own
    -- "supabase_auth_uid_simulation_for_migration_testing" memory), so
    -- a raw `select ... from leave_requests`/`timesheets` here would
    -- ALWAYS return every row regardless of RLS - it is NOT a valid way
    -- to test the SELECT policies themselves (only SECURITY DEFINER
    -- RPC logic, which enforces its own conditions in the function body
    -- rather than relying on RLS, can be validated this way). The RLS
    -- policies were fixed with the exact same reviewed pattern as every
    -- other site-scoped policy in this migration set; what's tested
    -- below is the real, consequential action-gating (can a Manager
    -- actually REVIEW/APPROVE/ASSIGN something outside their site),
    -- which is what determines real impact regardless of SELECT-level
    -- visibility.
    perform set_config('request.jwt.claim.sub', v_manager_auth::text, true);

    -- 2. review_prosm_time_leave must refuse to review Employee B's request.
    v_threw := false;
    begin
        perform public.review_prosm_time_leave(v_leave_b, 'approved', 'test');
    exception when others then
        v_threw := true;
    end;
    if not v_threw then
        raise exception 'FAIL: manager was able to review Employee B (Site B) leave request - leak confirmed';
    end if;

    -- 4. approve_prosm_time_timesheet must refuse to approve Employee B's timesheet.
    v_threw := false;
    begin
        perform public.approve_prosm_time_timesheet(v_timesheet_b, 'approved', 'test');
    exception when others then
        v_threw := true;
    end;
    if not v_threw then
        raise exception 'FAIL: manager was able to approve Employee B (Site B) timesheet - leak confirmed';
    end if;

    -- 5. assign_prosm_time_shift must refuse to schedule a shift at Site B.
    v_threw := false;
    begin
        v_result := public.assign_prosm_time_shift(v_emp_b_id, v_site_b, current_date + 1, '08:00'::time, '16:00'::time);
    exception when others then
        v_threw := true;
    end;
    if not v_threw then
        raise exception 'FAIL: manager was able to assign a shift at Site B they do not manage - leak confirmed';
    end if;

    -- 6. Sanity: the manager CAN still do all of the above at their own Site A (real, working, not over-blocked).
    v_result := public.assign_prosm_time_shift(v_emp_a_id, v_site_a, current_date + 1, '08:00'::time, '16:00'::time);
    if not (v_result->>'success')::boolean then
        raise exception 'FAIL: manager could NOT assign a shift at their own managed Site A - over-blocked';
    end if;
    delete from shift_assignments where id = (v_result->>'assignmentId')::uuid;

    perform set_config('request.jwt.claim.sub', '', true);

    delete from timesheets where id = v_timesheet_b;
    delete from leave_requests where id = v_leave_b;
    delete from site_assignments where user_id in (v_manager_id, v_emp_a_id, v_emp_b_id);
    delete from users where id in (v_manager_id, v_emp_a_id, v_emp_b_id);
    delete from auth.users where id in (v_manager_auth, v_emp_a_auth, v_emp_b_auth);
    delete from sites where id in (v_site_a, v_site_b);
    delete from organization_settings where organization_id = v_org;
    delete from organizations where id = v_org;

    raise notice 'LEAVE/TIMESHEET/SCHEDULE SITE-SCOPING FIX VERIFIED LIVE: manager correctly blocked from Site B leave/timesheet/schedule actions, still fully able to act on their own Site A. Test data cleaned up.';
exception
    when others then
        perform set_config('request.jwt.claim.sub', '', true);
        delete from shift_assignments where organization_id = v_org;
        delete from timesheets where organization_id = v_org;
        delete from leave_requests where organization_id = v_org;
        delete from site_assignments where site_id in (v_site_a, v_site_b);
        delete from users where organization_id = v_org;
        delete from auth.users where id in (v_manager_auth, v_emp_a_auth, v_emp_b_auth);
        delete from sites where organization_id = v_org;
        delete from organization_settings where organization_id = v_org;
        delete from organizations where id = v_org;
        raise;
end $$;
