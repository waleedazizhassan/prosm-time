-- PROSM Time - regression sweep part 2: (a) clean up one real orphaned
-- row left by the previous run's own test-script bug (SOS alert
-- b217757e-b04a-4b67-9386-3edf819886d5 - trigger_prosm_time_sos_alert
-- actually succeeded, but the test script read the wrong JSON field
-- name and never resolved/deleted it), (b) re-test the 5 areas whose
-- previous failures turned out to be test-script bugs, not app bugs,
-- now with corrected calls, (c) get change_prosm_time_site's two live
-- overload signatures for the duplication finding.
do $cleanup$
begin
    delete from notifications where related_entity_id = 'b217757e-b04a-4b67-9386-3edf819886d5'::uuid;
    delete from sos_alerts where id = 'b217757e-b04a-4b67-9386-3edf819886d5'::uuid;
    raise notice 'CLEANUP: orphaned SOS alert removed';
end;
$cleanup$;

do $retest$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth uuid := 'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc';
    v_employee uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9';
    v_employee_auth uuid := 'f8f8c181-fa33-457a-810e-0ad429a5efc6';

    v_site_id uuid;
    v_site_lat double precision;
    v_site_lng double precision;

    v_results text[] := array[]::text[];
    v_r jsonb;
    v_org_id_result uuid;

    v_session_id uuid;
    v_action_id uuid;
    v_leave_a uuid; v_leave_b uuid;
    v_sos_id uuid; v_presence_session_id uuid;
    v_timesheet_a uuid;
    v_api_key_id uuid; v_api_key_raw text;
    v_count integer;
begin
    select id, latitude, longitude into v_site_id, v_site_lat, v_site_lng
    from sites where organization_id = v_org and geofence_required = true and is_active = true
    order by name limit 1;

    -- RETEST 3: admin-on-behalf (fixed cleanup order: delete
    -- admin_on_behalf_actions before attendance_events)
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.admin_clock_in_prosm_time_attendance(v_employee, v_site_id, 'QA retest admin clock-in', null, 'retest-admin-in-' || gen_random_uuid()::text, v_site_lat, v_site_lng, 10, 'retest-device');
        v_session_id := (v_r->>'sessionId')::uuid;
        v_r := public.admin_clock_out_prosm_time_attendance(v_employee, 'QA retest admin clock-out', 'retest-admin-out-' || gen_random_uuid()::text, v_site_lat, v_site_lng, 10, 'retest-device');
        if v_session_id is not null and (v_r->>'success')::boolean then
            v_results := array_append(v_results, 'PASS 3(retest) admin-on-behalf: session=' || v_session_id);
        else
            v_results := array_append(v_results, 'FAIL 3(retest) admin-on-behalf: ' || v_r::text);
        end if;
        delete from admin_on_behalf_actions where session_id = v_session_id;
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
    exception when others then
        v_results := array_append(v_results, 'FAIL 3(retest) admin-on-behalf EXCEPTION: ' || sqlerrm);
    end;

    -- RETEST 4: leave (fixed action values: approved/rejected)
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.request_prosm_time_leave('annual', current_date + 70, current_date + 70, 'QA retest leave A');
        v_leave_a := (v_r->>'requestId')::uuid;
        v_r := public.request_prosm_time_leave('annual', current_date + 71, current_date + 71, 'QA retest leave B');
        v_leave_b := (v_r->>'requestId')::uuid;

        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.review_prosm_time_leave(v_leave_a, 'approved', 'QA retest approve');
        if not (v_r->>'success')::boolean then raise exception 'approve failed: %', v_r; end if;
        v_r := public.review_prosm_time_leave(v_leave_b, 'rejected', 'QA retest reject');
        if not (v_r->>'success')::boolean then raise exception 'reject failed: %', v_r; end if;

        v_results := array_append(v_results, 'PASS 4(retest) leave request/approve/reject: A=' ||
            (select status from leave_requests where id = v_leave_a) || ' B=' || (select status from leave_requests where id = v_leave_b));
    exception when others then
        v_results := array_append(v_results, 'FAIL 4(retest) leave EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id in (v_leave_a, v_leave_b);
    delete from leave_requests where id in (v_leave_a, v_leave_b);

    -- RETEST 7: sos trigger/resolve (fixed field name: alertId not sosAlertId)
    begin
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        v_r := public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'retest-sos-in-' || gen_random_uuid()::text,
            p_site_id => v_site_id, p_project_id => null, p_client_reported_at => now(),
            p_latitude => v_site_lat, p_longitude => v_site_lng, p_accuracy_meters => 10,
            p_manual_location_label => null, p_note => null, p_activity => null);
        v_session_id := (v_r->>'sessionId')::uuid;

        select id into v_presence_session_id from presence_sessions where attendance_session_id = v_session_id and status = 'active' limit 1;
        if v_presence_session_id is not null then
            v_r := public.trigger_prosm_time_sos_alert(v_presence_session_id, v_site_lat, v_site_lng, 10);
            v_sos_id := (v_r->>'alertId')::uuid;
            if v_sos_id is not null then
                perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
                v_r := public.resolve_prosm_time_sos_alert(v_sos_id, 'QA retest resolved');
                if (v_r->>'success')::boolean then
                    v_results := array_append(v_results, 'PASS 7(retest) sos trigger/resolve: id=' || v_sos_id || ' status=' || (select status from sos_alerts where id = v_sos_id));
                else
                    v_results := array_append(v_results, 'FAIL 7(retest) sos resolve: ' || v_r::text);
                end if;
            else
                v_results := array_append(v_results, 'FAIL 7(retest) sos trigger: ' || v_r::text);
            end if;
        else
            v_results := array_append(v_results, 'FAIL 7(retest) sos: no active presence_session found');
        end if;

        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        perform public.clock_out_prosm_time_attendance('retest-sos-out-' || gen_random_uuid()::text, now(), v_site_lat, v_site_lng, 10, null, null);
    exception when others then
        v_results := array_append(v_results, 'FAIL 7(retest) sos EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id = v_sos_id;
    delete from sos_alerts where id = v_sos_id;
    if v_session_id is not null then
        delete from attendance_events where session_id = v_session_id;
        delete from presence_sessions where attendance_session_id = v_session_id;
        delete from attendance_sessions where id = v_session_id;
    end if;

    -- RETEST 9: timesheet (fixed caller: Owner, not the employee self-generating)
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.generate_prosm_time_timesheet(v_employee, current_date - 7, current_date - 1);
        v_timesheet_a := (v_r->>'timesheetId')::uuid;
        perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
        perform public.submit_prosm_time_timesheet(v_timesheet_a);
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.approve_prosm_time_timesheet(v_timesheet_a, 'approve', 'QA retest approve');
        if not (v_r->>'success')::boolean then raise exception 'approve failed: %', v_r; end if;

        v_results := array_append(v_results, 'PASS 9(retest) timesheet generate(by Owner)/submit/approve: status=' ||
            (select status from timesheets where id = v_timesheet_a));
    exception when others then
        v_results := array_append(v_results, 'FAIL 9(retest) timesheet EXCEPTION: ' || sqlerrm);
    end;
    delete from notifications where related_entity_id = v_timesheet_a;
    delete from timesheets where id = v_timesheet_a;

    -- RETEST 13: api key (fixed: authenticate_prosm_time_api_key returns
    -- a plain uuid, not jsonb)
    begin
        perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
        v_r := public.generate_prosm_time_api_key('QA Retest Key', 'attendance:read');
        v_api_key_id := (v_r->>'keyId')::uuid;
        v_api_key_raw := v_r->>'apiKey';

        v_org_id_result := public.authenticate_prosm_time_api_key(v_api_key_raw);
        if v_org_id_result = v_org then
            v_results := array_append(v_results, 'PASS 13(retest) api-key generate/authenticate: id=' || v_api_key_id || ' resolved_org=' || v_org_id_result);
        else
            v_results := array_append(v_results, 'FAIL 13(retest) api-key authenticate: resolved ' || coalesce(v_org_id_result::text, 'NULL') || ' expected ' || v_org);
        end if;
    exception when others then
        v_results := array_append(v_results, 'FAIL 13(retest) api-key EXCEPTION: ' || sqlerrm);
    end;
    if v_api_key_id is not null then
        delete from api_keys where id = v_api_key_id;
    end if;

    raise notice '=== RETEST RESULTS ===';
    for v_count in 1..array_length(v_results, 1) loop
        raise notice '%', v_results[v_count];
    end loop;
end;
$retest$;

-- Overload detail for the 2 real duplicates found in the earlier scan.
do $overloads$
declare
    v_row record;
begin
    for v_row in
        select p.proname, p.oid, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('change_prosm_time_site', 'generate_prosm_time_api_key')
        order by p.proname, p.oid
    loop
        raise notice 'OVERLOAD % (oid %): args=(%) len=%', v_row.proname, v_row.oid, v_row.args, length(v_row.def);
    end loop;
end;
$overloads$;
