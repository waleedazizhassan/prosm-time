-- PROSM Time - self-cleaning verification of 20260909247000's fix: a
-- no-site presence session with a poor-accuracy sample that's within
-- (radius + accuracy) must NOT create an exception; one genuinely
-- beyond even that generous buffer still correctly does. Uses a
-- non-owner test account - the Owner is deliberately exempt from ever
-- being flagged (this session's own established rule), so testing
-- exception CREATION specifically requires a real employee subject.

begin;

do $verify$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_employee uuid;
    v_employee_auth_id uuid;
    v_test_attendance_session uuid;
    v_test_presence_session uuid;
    v_result jsonb;
    v_exception_count int;
begin
    select id, auth_user_id into v_employee, v_employee_auth_id from users where email = 'test-employee@prosm.net' and organization_id = v_org;
    perform set_config('request.jwt.claim.sub', v_employee_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_employee_auth_id, 'role', 'authenticated')::text, true);

    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at)
    values (v_org, v_employee, null, 'clocked_in', now())
    returning id into v_test_attendance_session;

    -- anchor at 30.0444,31.2357 (Cairo-ish), radius 100m, no site
    insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
    values (v_org, v_test_attendance_session, v_employee, null, 30.0444, 31.2357, 100, 'active', now())
    returning id into v_test_presence_session;

    -- ~150m away, reported accuracy 200m
    -- (150m real distance <= 100m radius + 200m accuracy = 300m effective -> must NOT create an exception)
    v_result := record_prosm_time_presence_sample(v_test_presence_session, 30.04575, 31.2357, 200, now());
    if (v_result->>'exceptionCreated')::boolean is not false then
        raise exception 'VERIFY FAILED: a sample within (radius + accuracy) incorrectly created an exception: %', v_result;
    end if;
    if (v_result->'geofence'->>'withinGeofence')::boolean is not true then
        raise exception 'VERIFY FAILED: withinGeofence should be true for this sample: %', v_result;
    end if;

    select count(*) into v_exception_count from geofence_exceptions where presence_session_id = v_test_presence_session;
    if v_exception_count <> 0 then
        raise exception 'VERIFY FAILED: no exception row should exist yet: %', v_exception_count;
    end if;

    -- ~5km away with the same 200m accuracy -> genuinely beyond any
    -- reasonable tolerance, must still create a real exception
    v_result := record_prosm_time_presence_sample(v_test_presence_session, 30.0894, 31.2357, 200, now());
    if (v_result->>'exceptionCreated')::boolean is not true then
        raise exception 'VERIFY FAILED: a sample genuinely ~5km away did NOT create an exception: %', v_result;
    end if;

    -- cleanup
    delete from notifications where related_entity_type = 'geofence_exceptions' and related_entity_id in (select id from geofence_exceptions where presence_session_id = v_test_presence_session);
    delete from geofence_exceptions where presence_session_id = v_test_presence_session;
    delete from presence_sessions where id = v_test_presence_session;
    delete from attendance_sessions where id = v_test_attendance_session;

    raise notice 'NO-SITE GEOFENCE ACCURACY TOLERANCE FIX VERIFIED';
end;
$verify$;

commit;
