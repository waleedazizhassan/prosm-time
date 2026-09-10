-- Self-cleaning live verification of 20260910190000's site-scoping fix.
-- Real org/sites/users/data created, tested via SET LOCAL request.jwt.
-- claim.sub (this session's established RLS-simulation technique -
-- current_prosm_time_user_id() reads auth.uid(), which reads this
-- claim; the report RPCs are SECURITY DEFINER so they enforce their
-- own permission checks internally and need no actual role switch -
-- the earlier attempt at this file also flipped the session's `role`
-- GUC to 'authenticated', which is unnecessary and broke this
-- migration's own cleanup DELETEs once inside the exception handler;
-- removed here), then fully removed. RAISE EXCEPTION on any assertion
-- failure so a failed push surfaces loudly, not silently.

-- Defensive pre-cleanup: the earlier, broken version of this file
-- inserted its real test rows before failing on its own cleanup step.
-- Safe no-op if nothing is left over.
delete from attendance_sessions where organization_id in (select id from organizations where organization_code = 'AUDIT-RPT-SCOPE');
delete from site_assignments where site_id in (select id from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-RPT-SCOPE'));
delete from users where organization_id in (select id from organizations where organization_code = 'AUDIT-RPT-SCOPE');
delete from auth.users where email in ('audit-mgr@test.local', 'audit-empa@test.local', 'audit-empb@test.local');
delete from sites where organization_id in (select id from organizations where organization_code = 'AUDIT-RPT-SCOPE');
delete from organization_settings where organization_id in (select id from organizations where organization_code = 'AUDIT-RPT-SCOPE');
delete from organizations where organization_code = 'AUDIT-RPT-SCOPE';

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
    v_sess_a uuid;
    v_sess_b uuid;
    v_count_a int;
    v_count_b int;
    v_workforce_count int;
begin
    select id into v_manager_role from roles where role_key = 'manager';
    select id into v_employee_role from roles where role_key = 'employee';

    insert into organizations (organization_code, name) values ('AUDIT-RPT-SCOPE', 'Audit Report Scoping Org') returning id into v_org;
    insert into organization_settings (organization_id) values (v_org);

    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site A (managed)', 30.0444, 31.2357) returning id into v_site_a;
    insert into sites (organization_id, name, latitude, longitude) values (v_org, 'Site B (not managed)', 31.2001, 29.9187) returning id into v_site_b;

    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_manager_auth, 'authenticated', 'authenticated', 'audit-mgr@test.local', 'x', now(), now(), now());
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_emp_a_auth, 'authenticated', 'authenticated', 'audit-empa@test.local', 'x', now(), now(), now());
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_emp_b_auth, 'authenticated', 'authenticated', 'audit-empb@test.local', 'x', now(), now(), now());

    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_manager_auth, v_org, v_manager_role, 'audit-mgr@test.local', 'Audit Manager', 'active', false)
    returning id into v_manager_id;
    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_emp_a_auth, v_org, v_employee_role, 'audit-empa@test.local', 'Audit Employee A', 'active', false)
    returning id into v_emp_a_id;
    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (v_emp_b_auth, v_org, v_employee_role, 'audit-empb@test.local', 'Audit Employee B', 'active', false)
    returning id into v_emp_b_id;

    -- Manager is the designated site-manager of Site A ONLY.
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_a, v_manager_id, 'manager');
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_a, v_emp_a_id, 'member');
    insert into site_assignments (site_id, user_id, role_at_site) values (v_site_b, v_emp_b_id, 'member');

    -- Real closed sessions at each site, well past 12h so both would
    -- surface on the Missing-Checkout report.
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
    values (v_org, v_emp_a_id, v_site_a, 'clocked_out', now() - interval '20 hours', now() - interval '5 hours')
    returning id into v_sess_a;
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
    values (v_org, v_emp_b_id, v_site_b, 'clocked_out', now() - interval '20 hours', now() - interval '5 hours')
    returning id into v_sess_b;

    -- Simulate the Manager's own real session (JWT claim only - the
    -- report RPCs are SECURITY DEFINER, no role switch needed or used).
    perform set_config('request.jwt.claim.sub', v_manager_auth::text, true);

    select count(*) into v_count_a from list_prosm_time_report_missing_checkouts(current_date - 2, current_date + 1) where site_name = 'Site A (managed)';
    select count(*) into v_count_b from list_prosm_time_report_missing_checkouts(current_date - 2, current_date + 1) where site_name = 'Site B (not managed)';
    if v_count_a <> 1 then raise exception 'FAIL: manager should see their OWN site A missing-checkout row (got %)', v_count_a; end if;
    if v_count_b <> 0 then raise exception 'FAIL: manager saw Site B missing-checkout row they do not manage (leak confirmed, got %)', v_count_b; end if;

    select count(*) into v_count_a from list_prosm_time_report_site_summary(current_date - 2, current_date + 1) where site_name = 'Site A (managed)';
    select count(*) into v_count_b from list_prosm_time_report_site_summary(current_date - 2, current_date + 1) where site_name = 'Site B (not managed)';
    if v_count_a <> 1 then raise exception 'FAIL: manager should see Site A in site-summary report (got %)', v_count_a; end if;
    if v_count_b <> 0 then raise exception 'FAIL: manager saw Site B in site-summary report they do not manage (got %)', v_count_b; end if;

    select count(*) into v_workforce_count from list_prosm_time_report_workforce() where full_name = 'Audit Employee B';
    if v_workforce_count <> 0 then raise exception 'FAIL: manager saw Employee B (Site B, not managed) in the Workforce report (got %)', v_workforce_count; end if;
    select count(*) into v_workforce_count from list_prosm_time_report_workforce() where full_name = 'Audit Employee A';
    if v_workforce_count <> 1 then raise exception 'FAIL: manager should see Employee A (their own Site A) in the Workforce report (got %)', v_workforce_count; end if;

    perform set_config('request.jwt.claim.sub', '', true);

    delete from attendance_sessions where id in (v_sess_a, v_sess_b);
    delete from site_assignments where user_id in (v_manager_id, v_emp_a_id, v_emp_b_id);
    delete from users where id in (v_manager_id, v_emp_a_id, v_emp_b_id);
    delete from auth.users where id in (v_manager_auth, v_emp_a_auth, v_emp_b_auth);
    delete from sites where id in (v_site_a, v_site_b);
    delete from organization_settings where organization_id = v_org;
    delete from organizations where id = v_org;

    raise notice 'REPORT CENTER SITE-SCOPING FIX VERIFIED LIVE: manager correctly sees only their own managed site, Site B data confirmed NOT leaked. Test data cleaned up.';
exception
    when others then
        perform set_config('request.jwt.claim.sub', '', true);
        delete from attendance_sessions where organization_id = v_org;
        delete from site_assignments where site_id in (v_site_a, v_site_b);
        delete from users where organization_id = v_org;
        delete from auth.users where id in (v_manager_auth, v_emp_a_auth, v_emp_b_auth);
        delete from sites where organization_id = v_org;
        delete from organization_settings where organization_id = v_org;
        delete from organizations where id = v_org;
        raise;
end $$;
