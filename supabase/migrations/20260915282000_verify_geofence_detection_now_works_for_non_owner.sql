-- PROSM Time - self-cleaning live verification for item 3's complete
-- fix (2026-09-15). Proves the full pipeline now works end-to-end for
-- a NON-Owner account (the exact gap the user's correction called
-- out), not just the Owner-skip case already verified in
-- 20260915233000.
--
-- Simulates QA Test Employee (a real non-Owner user,
-- 52c35a21-1d58-4cf4-80ba-fa206667d8d9) clocked in at a real site,
-- then calling the real clock_out_prosm_time_attendance RPC with a
-- location ~500m away (well beyond even the pre-fix 200m+ "at rest"
-- radius, so this also serves as a regression guard) and a realistic
-- 30m reported GPS accuracy. Asserts: the violation is DETECTED
-- (checked=true, withinGeofence=false - the part that was silently
-- failing for every non-Owner account before this fix), a real
-- geofence_exceptions row is created, and the subject gets their own
-- out_of_zone_employee notification (the part fixed by 20260915230000).
do $verify$
declare
    v_site_id uuid;
    v_site_lat double precision;
    v_site_lng double precision;
    v_test_org uuid;
    v_test_user_id uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9';
    v_session_id uuid;
    v_offset_lat double precision;
    v_result jsonb;
    v_exception_count integer;
    v_notification_count integer;
begin
    select organization_id into v_test_org from users where id = v_test_user_id;
    if v_test_org is null then
        raise exception 'VERIFY SETUP FAILED: test user % not found', v_test_user_id;
    end if;

    select id, latitude, longitude into v_site_id, v_site_lat, v_site_lng
    from sites where geofence_required = true and organization_id = v_test_org limit 1;

    if v_site_id is null then
        raise exception 'VERIFY SETUP FAILED: no geofence_required site found in test user''s org';
    end if;

    -- ~0.0045 degrees latitude is ~500m - well past the (now capped)
    -- 100 + 50 + 50 = 200m maximum effective radius.
    v_offset_lat := v_site_lat + 0.0045;

    -- Guard: this test user must have no other open session.
    delete from attendance_sessions where user_id = v_test_user_id and status = 'clocked_in';

    insert into attendance_sessions (id, organization_id, user_id, site_id, status, clock_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_test_org, v_test_user_id, v_site_id, 'clocked_in', now() - interval '2 hours', now() - interval '2 hours', now())
    returning id into v_session_id;

    perform set_config('request.jwt.claim.sub',
        (select auth_user_id::text from users where id = v_test_user_id), true);

    v_result := public.clock_out_prosm_time_attendance(
        p_idempotency_key => 'verify-nonowner-geofence-' || v_session_id::text,
        p_latitude => v_offset_lat,
        p_longitude => v_site_lng,
        p_accuracy_meters => 30
    );

    perform set_config('request.jwt.claim.sub', '', true);

    if (v_result->'geofence'->>'checked')::boolean is not true then
        raise exception 'VERIFY FAILED: geofence check did not run (checked=false), result=%', v_result;
    end if;
    if (v_result->'geofence'->>'withinGeofence')::boolean is not false then
        raise exception 'VERIFY FAILED: 500m-away clock-out was NOT flagged as a violation, result=%', v_result;
    end if;

    select count(*) into v_exception_count
    from geofence_exceptions where attendance_event_id = (v_result->>'eventId')::uuid;
    if v_exception_count <> 1 then
        raise exception 'VERIFY FAILED: expected 1 geofence_exceptions row, got %', v_exception_count;
    end if;

    select count(*) into v_notification_count
    from notifications
    where type = 'out_of_zone_employee' and user_id = v_test_user_id
      and created_at >= now() - interval '1 minute';
    if v_notification_count <> 1 then
        raise exception 'VERIFY FAILED: expected 1 out_of_zone_employee notification for the non-Owner subject, got %', v_notification_count;
    end if;

    raise notice 'VERIFIED: non-Owner 500m clock-out correctly detected, exception+notification both created. geofence=%', v_result->'geofence';

    -- Cleanup - remove everything this verification created.
    delete from notifications where type = 'out_of_zone_employee' and user_id = v_test_user_id and created_at >= now() - interval '1 minute';
    delete from geofence_exceptions where attendance_event_id = (v_result->>'eventId')::uuid;
    delete from attendance_events where id = (v_result->>'eventId')::uuid;
    delete from attendance_sessions where id = v_session_id;

    raise notice 'CLEANUP DONE';
end;
$verify$;
