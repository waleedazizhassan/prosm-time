-- PROSM Time - self-contained, self-cleaning live verification of
-- 20260915220000's own fix: kiosk and admin-on-behalf clock-in must
-- both be blocked while the subject has an approved leave request
-- covering today, exactly like self clock-in already was. Restores
-- every touched row to its original state.

begin;

do $verify$
declare
    v_org uuid;
    v_employee_id uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9'; -- QA Test Employee
    v_owner_id uuid := '24961637-458b-4df4-9549-508402a084b6'; -- admin@prosm.net
    v_owner_auth_id uuid;
    v_employee_auth_id uuid;
    v_site_id uuid;
    v_original_pin_hash text;
    v_leave_id uuid;
    v_error_message text;
    v_blocked boolean;
    v_result jsonb;
begin
    select organization_id, auth_user_id, kiosk_pin_hash into v_org, v_employee_auth_id, v_original_pin_hash
    from users where id = v_employee_id;
    if v_org is null then raise exception 'VERIFY SETUP FAILED: QA Test Employee not found'; end if;

    select auth_user_id into v_owner_auth_id from users where id = v_owner_id;
    select id into v_site_id from sites where organization_id = v_org and is_active = true and kiosk_mode in ('kiosk_only', 'both_allowed') limit 1;
    if v_site_id is null then raise exception 'VERIFY SETUP FAILED: no kiosk-enabled site found'; end if;

    -- 0) QA Test Employee has no real site_assignments row anywhere
    -- (confirmed live) - kiosk_clock_in requires one regardless of
    -- caller role, so a real (temporary) assignment is test setup, not
    -- part of what's being verified. Removed in cleanup.
    insert into site_assignments (site_id, user_id, role_at_site)
    values (v_site_id, v_employee_id, 'member')
    on conflict (site_id, user_id) do nothing;

    -- 1) Give the employee a real, known kiosk PIN for this test run
    -- (self-service RPC, simulating their own session).
    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_employee_auth_id, 'role', 'authenticated')::text, true);
    perform set_prosm_time_kiosk_pin('482913');

    -- 2) Create a real approved leave request covering today.
    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status, reason)
    values (v_org, v_employee_id, 'annual', current_date, current_date, 1, 'approved', 'PHASE-VERIFY: leave-block test')
    returning id into v_leave_id;

    -- 3) Kiosk clock-in, simulating the Owner's own kiosk-terminal
    -- session (kiosk auth is by PIN, but the RPC still needs a caller
    -- session for current_prosm_time_organization_id()).
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    v_blocked := false;
    begin
        perform kiosk_clock_in_prosm_time_attendance(v_site_id, v_employee_id, '482913', 'verify-kiosk-' || gen_random_uuid()::text);
    exception
        when others then
            get stacked diagnostics v_error_message = message_text;
            if v_error_message like '%ON APPROVED LEAVE%' then
                v_blocked := true;
            else
                raise exception 'VERIFY FAILED: kiosk clock-in failed for the wrong reason: %', v_error_message;
            end if;
    end;
    if not v_blocked then
        raise exception 'VERIFY FAILED: kiosk clock-in was NOT blocked during approved leave';
    end if;
    raise notice 'PASS: kiosk clock-in correctly blocked during approved leave';

    -- 4) Admin-on-behalf clock-in, same subject, same leave window.
    v_blocked := false;
    begin
        perform admin_clock_in_prosm_time_attendance(v_employee_id, v_site_id, 'PHASE-VERIFY: testing the block');
    exception
        when others then
            get stacked diagnostics v_error_message = message_text;
            if v_error_message like '%ON APPROVED LEAVE%' then
                v_blocked := true;
            else
                raise exception 'VERIFY FAILED: admin clock-in failed for the wrong reason: %', v_error_message;
            end if;
    end;
    if not v_blocked then
        raise exception 'VERIFY FAILED: admin-on-behalf clock-in was NOT blocked during approved leave';
    end if;
    raise notice 'PASS: admin-on-behalf clock-in correctly blocked during approved leave';

    -- 5) Confirm no attendance_sessions row leaked through either path.
    if exists (select 1 from attendance_sessions where user_id = v_employee_id and status = 'clocked_in') then
        raise exception 'VERIFY FAILED: a clock-in session exists despite both paths being blocked';
    end if;

    -- 6) Positive case - remove the leave, confirm kiosk clock-in now
    -- succeeds normally (the fix isn't overly broad).
    delete from leave_requests where id = v_leave_id;
    v_result := kiosk_clock_in_prosm_time_attendance(v_site_id, v_employee_id, '482913', 'verify-kiosk-ok-' || gen_random_uuid()::text);
    if (v_result->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: kiosk clock-in did not succeed once the leave was removed: %', v_result;
    end if;
    raise notice 'PASS: kiosk clock-in succeeds normally once no approved leave exists';

    -- cleanup: close the real session this created, restore the
    -- employee's original kiosk PIN state.
    update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = v_employee_id and status = 'clocked_in';
    delete from attendance_events where session_id in (select id from attendance_sessions where user_id = v_employee_id and clock_in_at::date = current_date);
    delete from attendance_sessions where user_id = v_employee_id and clock_in_at::date = current_date;
    delete from leave_requests where id = v_leave_id;
    update users set kiosk_pin_hash = v_original_pin_hash where id = v_employee_id;
    delete from site_assignments where site_id = v_site_id and user_id = v_employee_id;

    raise notice 'ALL LEAVE-BLOCK VERIFICATIONS PASSED';
end;
$verify$;

commit;
