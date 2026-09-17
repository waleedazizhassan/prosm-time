-- PROSM Time - self-cleaning live verification of 20260916500000's
-- Owner self-approve leave + org-wide list RPC. The real org
-- currently has only the Owner (confirmed live - no non-owner user
-- exists to test the unchanged regular path against), so this creates
-- one real, temporary employee (auth.users + users), same pattern
-- other verification migrations in this repo already use - removed
-- completely in cleanup, by its own captured id only.

begin;

do $verify$
declare
    v_org uuid;
    v_employee_id uuid;
    v_employee_created boolean := false;
    v_owner_id uuid;
    v_owner_auth_id uuid;
    v_employee_auth_id uuid;
    v_employee_role_id uuid;
    v_owner_request_id uuid;
    v_employee_request_id uuid;
    v_result jsonb;
    v_status text;
    v_reviewed_by uuid;
    v_threw boolean;
    v_org_wide_count integer;
    v_site_id uuid;
begin
    select id, organization_id, auth_user_id into v_owner_id, v_org, v_owner_auth_id from users where is_owner = true limit 1;
    if v_owner_id is null then raise exception 'VERIFY SETUP FAILED: no real Owner found'; end if;

    select id, auth_user_id into v_employee_id, v_employee_auth_id from users where organization_id = v_org and is_owner = false limit 1;
    if v_employee_id is null then
        v_employee_auth_id := gen_random_uuid();
        select id into v_employee_role_id from roles where role_key = 'employee' limit 1;
        insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, aud, role)
        values (v_employee_auth_id, 'verify-leave-employee-' || v_employee_auth_id::text || '@example.com', 'not-a-real-hash', now(), now(), now(), 'authenticated', 'authenticated');
        insert into users (auth_user_id, organization_id, role_id, full_name, email, status, is_owner)
        values (v_employee_auth_id, v_org, v_employee_role_id, 'PHASE-VERIFY Employee', 'verify-leave-employee-' || v_employee_auth_id::text || '@example.com', 'active', false)
        returning id into v_employee_id;
        v_employee_created := true;
        raise notice 'SETUP: no real non-owner user existed - created a temporary one for this test (will be removed in cleanup)';
    end if;

    -- 1) Owner requests leave for a date range with no attendance -
    -- must come back instantly approved, self-reviewed.
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);
    v_result := request_prosm_time_leave('annual', current_date + 100, current_date + 100, 'PHASE-VERIFY: owner self-approve test');
    if (v_result->>'success')::boolean is not true or (v_result->>'autoApproved')::boolean is not true then
        raise exception 'VERIFY FAILED: owner leave request did not report autoApproved=true: %', v_result;
    end if;
    v_owner_request_id := (v_result->>'requestId')::uuid;

    select status, reviewed_by into v_status, v_reviewed_by from leave_requests where id = v_owner_request_id;
    if v_status <> 'approved' or v_reviewed_by <> v_owner_id then
        raise exception 'VERIFY FAILED: owner leave request row is not self-approved (status=%, reviewed_by=%)', v_status, v_reviewed_by;
    end if;
    raise notice 'PASS: Owner leave request is instantly self-approved';

    -- 2) Regression - a plain employee's own request must still land
    -- as pending (unchanged behavior).
    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_employee_auth_id, 'role', 'authenticated')::text, true);
    v_result := request_prosm_time_leave('annual', current_date + 101, current_date + 101, 'PHASE-VERIFY: employee normal-flow regression test');
    if (v_result->>'autoApproved')::boolean is not false then
        raise exception 'VERIFY FAILED: a plain employee request reported autoApproved=true: %', v_result;
    end if;
    v_employee_request_id := (v_result->>'requestId')::uuid;
    select status into v_status from leave_requests where id = v_employee_request_id;
    if v_status <> 'pending' then
        raise exception 'VERIFY FAILED: employee leave request should still be pending, got %', v_status;
    end if;
    raise notice 'PASS: a plain employee''s own leave request still lands as pending (unchanged)';

    -- 3) list_prosm_time_all_leave_requests() - Owner-only.
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);
    select count(*) into v_org_wide_count from list_prosm_time_all_leave_requests() where id in (v_owner_request_id, v_employee_request_id);
    if v_org_wide_count <> 2 then
        raise exception 'VERIFY FAILED: org-wide list did not return both test requests for the Owner (found %)', v_org_wide_count;
    end if;
    raise notice 'PASS: Owner''s org-wide leave list includes both the Owner''s own and the employee''s request';

    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_employee_auth_id, 'role', 'authenticated')::text, true);
    v_threw := false;
    begin
        perform list_prosm_time_all_leave_requests();
    exception when others then
        v_threw := true;
    end;
    if not v_threw then
        raise exception 'VERIFY FAILED: a plain employee was able to call the Owner-only org-wide leave list';
    end if;
    raise notice 'PASS: a plain employee is correctly blocked from the org-wide leave list';

    -- cleanup: both test requests, by their own returned ids only.
    delete from leave_requests where id in (v_owner_request_id, v_employee_request_id);

    -- 4) Attendance-conflict guard for the Owner's own auto-approve -
    -- uses a real temporary attendance_sessions row this script both
    -- creates and removes.
    select id into v_site_id from sites where organization_id = v_org and is_active = true limit 1;
    if v_site_id is not null then
        insert into attendance_sessions (organization_id, user_id, site_id, clock_in_at, status)
        values (v_org, v_owner_id, v_site_id, (current_date + 102)::timestamptz + interval '9 hours', 'clocked_out')
        returning id into v_owner_request_id; -- reusing the variable, different meaning now (session id)

        perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
        perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);
        v_threw := false;
        begin
            perform request_prosm_time_leave('annual', current_date + 102, current_date + 102, 'PHASE-VERIFY: should be blocked by attendance conflict');
        exception when others then
            v_threw := true;
        end;
        if not v_threw then
            raise exception 'VERIFY FAILED: Owner was able to self-approve leave over a date with real attendance recorded';
        end if;
        raise notice 'PASS: Owner self-approve correctly blocked when attendance exists for the same date';

        delete from attendance_sessions where id = v_owner_request_id;
    else
        raise notice 'SKIPPED: attendance-conflict check (no active site found in this org to attach a test session to)';
    end if;

    perform set_config('request.jwt.claim.sub', '', true);

    if v_employee_created then
        delete from users where id = v_employee_id;
        delete from auth.users where id = v_employee_auth_id;
        raise notice 'CLEANUP: removed the temporary employee fixture';
    end if;

    raise notice '=== ALL OWNER LEAVE SELF-APPROVE CHECKS PASSED ===';
end;
$verify$;

commit;
