-- PROSM Time - self-contained, self-cleaning live verification of
-- 20260915260000's own Absence report: a real scheduled shift with no
-- attendance and no approved leave must be flagged; a real scheduled
-- shift WITH attendance, or WITH approved leave, must not be.
-- Restores every touched row to its original state.

begin;

do $verify$
declare
    v_employee_id uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9'; -- QA Test Employee
    v_org uuid;
    v_employee_auth_id uuid;
    v_site_id uuid;
    v_absence_shift_date date := current_date - interval '2 days';
    v_attended_shift_date date := current_date - interval '3 days';
    v_leave_shift_date date := current_date - interval '4 days';
    v_shift_absence_id uuid;
    v_shift_attended_id uuid;
    v_shift_leave_id uuid;
    v_leave_id uuid;
    v_session_id uuid;
    v_absences jsonb;
    v_flagged_dates date[];
begin
    select organization_id, auth_user_id into v_org, v_employee_auth_id from users where id = v_employee_id;
    if v_org is null then raise exception 'VERIFY SETUP FAILED: QA Test Employee not found'; end if;

    select id into v_site_id from sites where organization_id = v_org and is_active = true limit 1;
    if v_site_id is null then raise exception 'VERIFY SETUP FAILED: no active site found'; end if;

    -- Case 1: real absence (scheduled, no attendance, no leave).
    insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time, status)
    values (v_org, v_employee_id, v_site_id, v_absence_shift_date, '08:00', '16:00', 'scheduled')
    returning id into v_shift_absence_id;

    -- Case 2: scheduled, but real attendance exists - must NOT be flagged.
    insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time, status)
    values (v_org, v_employee_id, v_site_id, v_attended_shift_date, '08:00', '16:00', 'scheduled')
    returning id into v_shift_attended_id;
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
    values (v_org, v_employee_id, v_site_id, 'clocked_out', v_attended_shift_date + time '08:05', v_attended_shift_date + time '16:05')
    returning id into v_session_id;

    -- Case 3: scheduled, but covered by approved leave - must NOT be flagged.
    insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time, status)
    values (v_org, v_employee_id, v_site_id, v_leave_shift_date, '08:00', '16:00', 'scheduled')
    returning id into v_shift_leave_id;
    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status, reason)
    values (v_org, v_employee_id, 'annual', v_leave_shift_date, v_leave_shift_date, 1, 'approved', 'PHASE-VERIFY: absence report test')
    returning id into v_leave_id;

    -- Simulate the Owner's own session to call the RPC (Owner-gated read).
    perform set_config('request.jwt.claim.sub', (select auth_user_id from users where id = '24961637-458b-4df4-9549-508402a084b6')::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', (select auth_user_id from users where id = '24961637-458b-4df4-9549-508402a084b6'), 'role', 'authenticated')::text, true);

    select coalesce(jsonb_agg(row), '[]'::jsonb) into v_absences
    from list_prosm_time_report_absences(v_leave_shift_date, v_absence_shift_date) row;

    select array_agg((row->>'shift_date')::date) into v_flagged_dates
    from jsonb_array_elements(v_absences) row;

    if not (v_absence_shift_date = any(v_flagged_dates)) then
        raise exception 'VERIFY FAILED: the real absence (no attendance, no leave) was NOT flagged: %', v_absences;
    end if;
    raise notice 'PASS: a real absence (scheduled, no attendance, no leave) was correctly flagged';

    if v_attended_shift_date = any(v_flagged_dates) then
        raise exception 'VERIFY FAILED: a shift with real attendance was incorrectly flagged as an absence';
    end if;
    raise notice 'PASS: a shift with real attendance was correctly NOT flagged';

    if v_leave_shift_date = any(v_flagged_dates) then
        raise exception 'VERIFY FAILED: a shift covered by approved leave was incorrectly flagged as an absence';
    end if;
    raise notice 'PASS: a shift covered by approved leave was correctly NOT flagged';

    -- cleanup: remove every trace of this verification run.
    delete from attendance_events where session_id = v_session_id;
    delete from attendance_sessions where id = v_session_id;
    delete from leave_requests where id = v_leave_id;
    delete from shift_assignments where id in (v_shift_absence_id, v_shift_attended_id, v_shift_leave_id);

    raise notice 'ALL ABSENCE REPORT VERIFICATIONS PASSED';
end;
$verify$;

commit;
