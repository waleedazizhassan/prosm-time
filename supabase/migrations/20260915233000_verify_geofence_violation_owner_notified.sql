-- PROSM Time - self-contained, self-cleaning live verification of
-- 20260915230000's own fix: an Owner's own geofence violation must now
-- create a real geofence_exceptions row + notification, exactly like
-- any other org member's. Restores every touched row to its original
-- state.

begin;

do $verify$
declare
    v_owner_id uuid := '24961637-458b-4df4-9549-508402a084b6'; -- admin@prosm.net
    v_org uuid;
    v_result jsonb;
    v_exception_id uuid;
    v_notification_count int;
    v_session_id uuid;
    v_event_id uuid;
begin
    select organization_id into v_org from users where id = v_owner_id;
    if v_org is null then raise exception 'VERIFY SETUP FAILED: Owner not found'; end if;

    -- geofence_exceptions requires exactly one real source row
    -- (attendance_event_id xor presence_session_id) - a real minimal
    -- clock-in + its own attendance_events row, exactly what a real
    -- clock-in/clock-out call would already have on hand.
    insert into attendance_sessions (organization_id, user_id, status, clock_in_at)
    values (v_org, v_owner_id, 'clocked_out', now() - interval '1 hour')
    returning id into v_session_id;
    insert into attendance_events (session_id, user_id, event_type, occurred_at, idempotency_key)
    values (v_session_id, v_owner_id, 'clock_in', now() - interval '1 hour', 'phase-verify-' || gen_random_uuid()::text)
    returning id into v_event_id;

    -- Call the fixed function directly with a real, large violation
    -- distance - exactly what every real geofence-checking call site
    -- (clock-in, clock-out, presence sample) already does.
    v_result := handle_prosm_time_geofence_violation(p_organization_id => v_org, p_user_id => v_owner_id, p_distance_meters => 850.0, p_attendance_event_id => v_event_id);

    if (v_result->>'exceptionCreated')::boolean is not true then
        raise exception 'VERIFY FAILED: Owner violation did not create an exception: %', v_result;
    end if;
    v_exception_id := (v_result->>'exceptionId')::uuid;
    raise notice 'PASS: Owner geofence violation created a real exception (%)', v_exception_id;

    if not exists (select 1 from geofence_exceptions where id = v_exception_id and user_id = v_owner_id and status = 'pending_reason') then
        raise exception 'VERIFY FAILED: no matching geofence_exceptions row found for the Owner';
    end if;
    raise notice 'PASS: geofence_exceptions row confirmed for the Owner';

    select count(*) into v_notification_count
    from notifications
    where organization_id = v_org
      and user_id = v_owner_id
      and type = 'out_of_zone_employee'
      and related_entity_id = v_exception_id;
    if v_notification_count <> 1 then
        raise exception 'VERIFY FAILED: expected exactly 1 out_of_zone_employee notification for the Owner, found %', v_notification_count;
    end if;
    raise notice 'PASS: the Owner received their own out_of_zone_employee notification';

    -- cleanup: remove every trace of this verification run.
    delete from notifications where related_entity_id = v_exception_id and organization_id = v_org;
    delete from geofence_exceptions where id = v_exception_id;
    delete from attendance_events where id = v_event_id;
    delete from attendance_sessions where id = v_session_id;

    raise notice 'ALL OWNER GEOFENCE NOTIFICATION VERIFICATIONS PASSED';
end;
$verify$;

commit;
