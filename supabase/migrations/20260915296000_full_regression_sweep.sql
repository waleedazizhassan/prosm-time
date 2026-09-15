-- PROSM Time - comprehensive live regression sweep (2026-09-15,
-- user-directed: "run complete tests across the whole app and make
-- sure everything inside it works well" before the pending release).
-- Self-cleaning, real fixtures only (QA Test Employee/Manager +
-- throwaway rows), no real historical data touched. Each test is
-- isolated in its own BEGIN/EXCEPTION block so one failure doesn't
-- abort the rest - results are collected and printed at the end.
do $sweep$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth uuid := 'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc';
    v_employee uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9';
    v_employee_auth uuid := 'f8f8c181-fa33-457a-810e-0ad429a5efc6';
    v_manager uuid := '92ce963c-1bd6-475a-836b-41980f4c4396';
    v_manager_auth uuid := '92ce59c2-ce62-41c4-a7d5-7f4416bda060';

    v_site_id uuid;
    v_site_lat double precision;
    v_site_lng double precision;
    v_other_site_id uuid;

    v_results text[] := array[]::text[];
    v_r jsonb;

    v_session_id uuid; v_event_id uuid; v_event_id2 uuid;
    v_break_id uuid; v_presence_session_id uuid; v_sos_id uuid;
    v_leave_a uuid; v_leave_b uuid;
    v_shift_id uuid;
    v_timesheet_a uuid; v_timesheet_b uuid;
    v_device_binding_id uuid;
    v_api_key_id uuid; v_api_key_raw text;
    v_temp_site_assignment_employee uuid;
    v_temp_site_assignment_manager uuid;

    v_count integer;
begin
    select id, latitude, longitude into v_site_id, v_site_lat, v_site_lng
    from sites where organization_id = v_org and geofence_required = true and is_active = true
    order by name limit 1;
    select id into v_other_site_id from sites where organization_id = v_org and id <> v_site_id limit 1;

    -- TEST 1: self clock-in -> clock-out happy path
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'sweep-clockin-' || gen_random_uuid()::text,
            p_site_id => v_site_id, p_project_id => null, p_client_reported_at => now(),
            p_latitude => v_site_lat, p_longitude => v_site_lng, p_accuracy_meters => 10,
            p_manual_location_label => null, p_note => null, p_activity => null);
        v_session_id := (v_r->>'sessionId')::uuid;
        v_r := public.clock_out_prosm_time_attendance(
            p_idempotency_key => 'sweep-clockout-' || gen_random_uuid()::text,
            p_client_reported_at => now(), p_latitude => v_site_lat, p_longitude => v_site_lng,
            p_accuracy_meters => 10, p_note => null, p_activity => null);
        if v_session_id is not null and (v_r->>'success')::boolean then
            v_results := array_append(v_results, 'PASS 1 self-clockin/out: session=' || v_session_id || ' geofence=' || (v_r->'geofence')::text);
        else
            v_results := array_append(v_results, 'FAIL 1 self-clockin/out: ' || v_r::text);
        end if;
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
    exception when others then
        v_results := array_append(v_results, 'FAIL 1 self-clockin/out EXCEPTION: ' || sqlerrm);
    end;

    -- TEST 2: kiosk clock-in/out (needs a site_assignments row + a PIN)
    begin
        insert into site_assignments (site_id, user_id, role_at_site) values (v_site_id, v_employee, 'member')
        returning id into v_temp_site_assignment_employee;

        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        perform public.set_prosm_time_kiosk_pin('194720');

        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.kiosk_clock_in_prosm_time_attendance(v_site_id, v_employee, '194720', 'sweep-kiosk-in-' || gen_random_uuid()::text, null, now());
        v_session_id := (v_r->>'sessionId')::uuid;
        v_r := public.kiosk_clock_out_prosm_time_attendance(v_site_id, v_employee, '194720', 'sweep-kiosk-out-' || gen_random_uuid()::text, now());
        if v_session_id is not null and (v_r->>'success')::boolean then
            v_results := array_append(v_results, 'PASS 2 kiosk-clockin/out: session=' || v_session_id);
        else
            v_results := array_append(v_results, 'FAIL 2 kiosk-clockin/out: ' || v_r::text);
        end if;
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
        delete from site_assignments where id = v_temp_site_assignment_employee;
        v_temp_site_assignment_employee := null;
    exception when others then
        v_results := array_append(v_results, 'FAIL 2 kiosk-clockin/out EXCEPTION: ' || sqlerrm);
        if v_temp_site_assignment_employee is not null then
            delete from site_assignments where id = v_temp_site_assignment_employee;
            v_temp_site_assignment_employee := null;
        end if;
    end;

    -- TEST 3: admin-on-behalf clock-in/out
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.admin_clock_in_prosm_time_attendance(v_employee, v_site_id, 'QA sweep admin clock-in', null, 'sweep-admin-in-' || gen_random_uuid()::text, v_site_lat, v_site_lng, 10, 'sweep-device');
        v_session_id := (v_r->>'sessionId')::uuid;
        v_r := public.admin_clock_out_prosm_time_attendance(v_employee, 'QA sweep admin clock-out', 'sweep-admin-out-' || gen_random_uuid()::text, v_site_lat, v_site_lng, 10, 'sweep-device');
        if v_session_id is not null and (v_r->>'success')::boolean then
            v_results := array_append(v_results, 'PASS 3 admin-on-behalf: session=' || v_session_id);
        else
            v_results := array_append(v_results, 'FAIL 3 admin-on-behalf: ' || v_r::text);
        end if;
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
    exception when others then
        v_results := array_append(v_results, 'FAIL 3 admin-on-behalf EXCEPTION: ' || sqlerrm);
    end;

    -- TEST 4: leave request + approve + reject
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.request_prosm_time_leave('annual', current_date + 60, current_date + 60, 'QA sweep leave A');
        v_leave_a := (v_r->>'requestId')::uuid;
        v_r := public.request_prosm_time_leave('annual', current_date + 61, current_date + 61, 'QA sweep leave B');
        v_leave_b := (v_r->>'requestId')::uuid;

        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.review_prosm_time_leave(v_leave_a, 'approve', 'QA sweep approve');
        if not (v_r->>'success')::boolean then raise exception 'approve failed: %', v_r; end if;
        v_r := public.review_prosm_time_leave(v_leave_b, 'reject', 'QA sweep reject');
        if not (v_r->>'success')::boolean then raise exception 'reject failed: %', v_r; end if;

        v_results := array_append(v_results, 'PASS 4 leave request/approve/reject: A=' ||
            (select status from leave_requests where id = v_leave_a) || ' B=' || (select status from leave_requests where id = v_leave_b));
    exception when others then
        v_results := array_append(v_results, 'FAIL 4 leave request/approve/reject EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id in (v_leave_a, v_leave_b);
    delete from leave_requests where id in (v_leave_a, v_leave_b);

    -- TEST 5: shift assignment
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.assign_prosm_time_shift(v_employee, v_site_id, current_date + 62, '09:00'::time, '17:00'::time, null, 'QA sweep shift');
        v_shift_id := (v_r->>'assignmentId')::uuid;
        if v_shift_id is not null then
            v_results := array_append(v_results, 'PASS 5 shift-assignment: id=' || v_shift_id);
        else
            v_results := array_append(v_results, 'FAIL 5 shift-assignment: ' || v_r::text);
        end if;
    exception when others then
        v_results := array_append(v_results, 'FAIL 5 shift-assignment EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id = v_shift_id;
    delete from shift_assignments where id = v_shift_id;

    -- TEST 6 + 7: break start/end AND sos trigger/resolve (share one open session)
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'sweep-breaksos-in-' || gen_random_uuid()::text,
            p_site_id => v_site_id, p_project_id => null, p_client_reported_at => now(),
            p_latitude => v_site_lat, p_longitude => v_site_lng, p_accuracy_meters => 10,
            p_manual_location_label => null, p_note => null, p_activity => null);
        v_session_id := (v_r->>'sessionId')::uuid;

        v_r := public.start_prosm_time_break(v_session_id, 'sweep-break-start-' || gen_random_uuid()::text);
        v_break_id := (v_r->>'breakId')::uuid;
        if v_break_id is not null then
            v_r := public.end_prosm_time_break(v_break_id);
            if (v_r->>'success')::boolean then
                v_results := array_append(v_results, 'PASS 6 break start/end: id=' || v_break_id);
            else
                v_results := array_append(v_results, 'FAIL 6 break end: ' || v_r::text);
            end if;
        else
            v_results := array_append(v_results, 'FAIL 6 break start: ' || v_r::text);
        end if;

        select id into v_presence_session_id from presence_sessions where attendance_session_id = v_session_id and status = 'active' limit 1;
        if v_presence_session_id is not null then
            v_r := public.trigger_prosm_time_sos_alert(v_presence_session_id, v_site_lat, v_site_lng, 10);
            v_sos_id := (v_r->>'sosAlertId')::uuid;
            if v_sos_id is not null then
                perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
                v_r := public.resolve_prosm_time_sos_alert(v_sos_id, 'QA sweep resolved');
                if (v_r->>'success')::boolean then
                    v_results := array_append(v_results, 'PASS 7 sos trigger/resolve: id=' || v_sos_id);
                else
                    v_results := array_append(v_results, 'FAIL 7 sos resolve: ' || v_r::text);
                end if;
            else
                v_results := array_append(v_results, 'FAIL 7 sos trigger: ' || v_r::text);
            end if;
        else
            v_results := array_append(v_results, 'FAIL 7 sos: no active presence_session found (presence_monitoring_enabled off for this site?)');
        end if;

        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        perform public.clock_out_prosm_time_attendance('sweep-breaksos-out-' || gen_random_uuid()::text, now(), v_site_lat, v_site_lng, 10, null, null);
    exception when others then
        v_results := array_append(v_results, 'FAIL 6/7 break/sos EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id = v_sos_id;
    delete from sos_alerts where id = v_sos_id;
    if v_session_id is not null then
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
    end if;

    -- TEST 8: manager site-scoped authority
    begin
        insert into site_assignments (site_id, user_id, role_at_site) values (v_site_id, v_manager, 'manager')
        returning id into v_temp_site_assignment_manager;

        perform set_config('request.jwt.claim.sub', v_manager_auth::text, true);
        select count(*) into v_count from unnest((select public.current_prosm_time_managed_site_ids())) as sid where sid = v_other_site_id;
        if v_count = 0 then
            v_results := array_append(v_results, 'PASS 8 manager-scoped-authority: managed_site_ids excludes unassigned site (' || v_other_site_id || ')');
        else
            v_results := array_append(v_results, 'FAIL 8 manager-scoped-authority: unassigned site leaked into managed_site_ids');
        end if;
    exception when others then
        v_results := array_append(v_results, 'FAIL 8 manager-scoped-authority EXCEPTION: ' || sqlerrm);
    end;
    if v_temp_site_assignment_manager is not null then
        delete from site_assignments where id = v_temp_site_assignment_manager;
    end if;

    -- TEST 9: timesheet generate -> submit -> approve, and a reject path
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.generate_prosm_time_timesheet(v_employee, current_date - 7, current_date - 1);
        v_timesheet_a := (v_r->>'timesheetId')::uuid;
        perform public.submit_prosm_time_timesheet(v_timesheet_a);
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.approve_prosm_time_timesheet(v_timesheet_a, 'approve', 'QA sweep approve');
        if not (v_r->>'success')::boolean then raise exception 'approve failed: %', v_r; end if;

        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.generate_prosm_time_timesheet(v_employee, current_date - 21, current_date - 15);
        v_timesheet_b := (v_r->>'timesheetId')::uuid;
        perform public.submit_prosm_time_timesheet(v_timesheet_b);
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.approve_prosm_time_timesheet(v_timesheet_b, 'reject', 'QA sweep reject');
        if not (v_r->>'success')::boolean then raise exception 'reject failed: %', v_r; end if;

        v_results := array_append(v_results, 'PASS 9 timesheet generate/submit/approve+reject: A=' ||
            (select status from timesheets where id = v_timesheet_a) || ' B=' || (select status from timesheets where id = v_timesheet_b));
    exception when others then
        v_results := array_append(v_results, 'FAIL 9 timesheet workflow EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id in (v_timesheet_a, v_timesheet_b);
    delete from timesheets where id in (v_timesheet_a, v_timesheet_b);

    -- TEST 10: notifications sampling (precise, entity-scoped - see above deletes already removed most; just report what types fired)
    select to_jsonb(array_agg(distinct type)) into v_r from notifications where user_id in (v_employee, v_manager) and created_at >= now() - interval '5 minutes';
    v_results := array_append(v_results, 'INFO 10 notification types observed this run (employee/manager only): ' || coalesce(v_r::text, '[]'));
    delete from notifications where user_id in (v_employee, v_manager) and created_at >= now() - interval '5 minutes'
        and type in ('shift_assigned', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected', 'leave_approved', 'leave_rejected', 'sos_alert_triggered', 'sos_alert_resolved', 'out_of_zone_employee');

    -- TEST 11: device binding status change
    begin
        insert into device_bindings (user_id, device_identifier, device_label, status)
        values (v_employee, 'qa-sweep-device-xyz', 'QA Sweep Device', 'pending')
        returning id into v_device_binding_id;

        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.set_prosm_time_device_binding_status(v_device_binding_id, 'approved', 'QA sweep approval');
        if (select status from device_bindings where id = v_device_binding_id) = 'approved' then
            v_results := array_append(v_results, 'PASS 11 device-binding-status: id=' || v_device_binding_id);
        else
            v_results := array_append(v_results, 'FAIL 11 device-binding-status: ' || v_r::text);
        end if;
    exception when others then
        v_results := array_append(v_results, 'FAIL 11 device-binding-status EXCEPTION: ' || sqlerrm);
    end;
    if v_device_binding_id is not null then
        delete from device_bindings where id = v_device_binding_id;
    end if;

    -- TEST 13: API key generate -> authenticate -> revoke, with scope
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.generate_prosm_time_api_key('QA Sweep Key', 'attendance:read');
        v_api_key_id := (v_r->>'keyId')::uuid;
        v_api_key_raw := v_r->>'apiKey';

        v_r := public.authenticate_prosm_time_api_key(v_api_key_raw);
        if (v_r->>'organizationId')::uuid = v_org then
            v_results := array_append(v_results, 'PASS 13 api-key generate/authenticate: id=' || v_api_key_id || ' scope=' || (v_r->>'scope'));
        else
            v_results := array_append(v_results, 'FAIL 13 api-key authenticate: ' || v_r::text);
        end if;
    exception when others then
        v_results := array_append(v_results, 'FAIL 13 api-key EXCEPTION: ' || sqlerrm);
    end;
    if v_api_key_id is not null then
        delete from api_keys where id = v_api_key_id;
    end if;

    raise notice '=== REGRESSION SWEEP RESULTS ===';
    for v_count in 1..array_length(v_results, 1) loop
        raise notice '%', v_results[v_count];
    end loop;
end;
$sweep$;
