-- Self-cleaning live verification for 20260910110000. Simulates the
-- kept QA test-employee account's own real session (SET LOCAL request.
-- jwt.claim.sub - the established technique for exercising a
-- SECURITY DEFINER RPC's real auth.uid()-derived logic from a
-- migration) and confirms clock-in is now actually blocked while an
-- approved leave request covers today, then confirms it is NOT
-- blocked once that leave request is gone - proving the check is real
-- and not overly broad. All test rows are removed before commit.
do $$
declare
    v_auth_user_id uuid;
    v_user_id uuid;
    v_leave_id uuid;
    v_blocked boolean := false;
    v_error_message text;
begin
    select id, auth_user_id into v_user_id, v_auth_user_id
    from users where email = 'test-employee@prosm.net';

    if v_user_id is null then
        raise notice 'SKIP: test-employee@prosm.net not found - verification skipped, not failed.';
        return;
    end if;

    -- Make sure this account has no open session so "already clocked
    -- in" can never mask the check this migration is verifying.
    if exists (select 1 from attendance_sessions where user_id = v_user_id and status = 'clocked_in') then
        raise notice 'SKIP: test-employee currently has an open session - verification skipped to avoid disturbing real state.';
        return;
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, status)
    select organization_id, v_user_id, 'annual', current_date, current_date, 1, 'verify-leave-conflict-clockin-block', 'approved'
    from users where id = v_user_id
    returning id into v_leave_id;

    perform set_config('request.jwt.claim.sub', v_auth_user_id::text, true);

    begin
        perform public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'verify-leave-block-' || gen_random_uuid()::text,
            p_manual_location_label => 'verification walk-in'
        );
        raise exception 'VERIFICATION FAILED: clock-in succeeded while an approved leave request covered today.';
    exception
        when others then
            get stacked diagnostics v_error_message = message_text;
            if v_error_message like '%YOU ARE ON APPROVED LEAVE TODAY%' then
                v_blocked := true;
            else
                raise exception 'VERIFICATION FAILED: expected YOU ARE ON APPROVED LEAVE TODAY, got: %', v_error_message;
            end if;
    end;

    if not v_blocked then
        raise exception 'VERIFICATION FAILED: clock-in was not blocked as expected.';
    end if;

    -- Now remove the leave request and confirm a real clock-in is NOT
    -- blocked - proves the check is scoped to an actual approved leave
    -- covering today, not some overly broad condition. Roll the
    -- resulting session back immediately - this must not leave a real
    -- open attendance session behind.
    delete from leave_requests where id = v_leave_id;

    begin
        perform public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'verify-leave-block-negative-' || gen_random_uuid()::text,
            p_manual_location_label => 'verification walk-in'
        );
        raise notice 'OK: clock-in succeeds normally once the leave request is gone.';
    exception
        when others then
            get stacked diagnostics v_error_message = message_text;
            raise exception 'VERIFICATION FAILED: clock-in unexpectedly still blocked after removing the leave request: %', v_error_message;
    end;

    raise notice 'VERIFIED: approved-leave-today correctly blocks self clock-in (and only while it actually applies).';
end $$;

-- Clean up the session/event/presence-session the negative-case probe
-- above created for real, and the leave request if the earlier block
-- somehow still left one behind.
delete from presence_sessions where user_id = (select id from users where email = 'test-employee@prosm.net')
  and attendance_session_id in (
    select id from attendance_sessions where user_id = (select id from users where email = 'test-employee@prosm.net')
      and manual_location_label = 'verification walk-in'
  );
delete from attendance_events where session_id in (
    select id from attendance_sessions where user_id = (select id from users where email = 'test-employee@prosm.net')
      and manual_location_label = 'verification walk-in'
);
delete from attendance_sessions where user_id = (select id from users where email = 'test-employee@prosm.net')
  and manual_location_label = 'verification walk-in';
delete from leave_requests where reason = 'verify-leave-conflict-clockin-block';
