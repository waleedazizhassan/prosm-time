-- PROSM Time - self-contained, self-cleaning verification that an
-- overnight shift (e.g. 22:00-06:00) is now a single real shift
-- record with correct overlap detection in both directions across the
-- day boundary. Net schema effect: zero.

begin;

do $verify$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth_id uuid;
    v_site uuid;
    v_template jsonb;
    v_night_assignment jsonb;
    v_conflict_result jsonb;
    v_conflict_raised boolean := false;
    v_row record;
    v_crosses boolean;
begin
    select auth_user_id into v_owner_auth_id from users where id = v_owner;
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    insert into sites (organization_id, name, latitude, longitude, allowed_radius_meters)
    values (v_org, 'Overnight Verify Temp Site', 30.0444, 31.2357, 100)
    returning id into v_site;

    -- 1) an overnight TEMPLATE (22:00-06:00) is now accepted, not rejected
    v_template := create_prosm_time_shift_template(v_site, 'Night Verify', '22:00'::time, '06:00'::time, null);
    if (v_template->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: overnight template was rejected: %', v_template;
    end if;

    -- 2) an overnight ASSIGNMENT (22:00-06:00 on day D) is accepted as ONE shift
    v_night_assignment := assign_prosm_time_shift(v_owner, v_site, '2026-09-15'::date, '22:00'::time, '06:00'::time, null, 'overnight verify');
    if (v_night_assignment->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: overnight assignment was rejected: %', v_night_assignment;
    end if;

    -- 3) crosses_midnight is correctly reported
    select crosses_midnight into v_crosses from list_prosm_time_site_shifts(v_site, '2026-09-15'::date, '2026-09-15'::date) where id = (v_night_assignment->>'assignmentId')::uuid;
    if v_crosses is not true then
        raise exception 'VERIFY FAILED: crosses_midnight was not true for the overnight shift';
    end if;

    -- 4) a NEW shift on day D+1 starting at 05:00 (before the overnight
    -- shift's real 06:00 end) MUST be rejected as overlapping - this is
    -- exactly the cross-midnight overlap case the old same-day-only
    -- check could never catch.
    begin
        perform assign_prosm_time_shift(v_owner, v_site, '2026-09-16'::date, '05:00'::time, '09:00'::time, null, null);
        v_conflict_raised := false;
    exception
        when others then
            v_conflict_raised := true;
            if sqlerrm not ilike '%OVERLAPPING SHIFT%' then
                raise exception 'VERIFY FAILED: wrong error for the cross-midnight overlap case: %', sqlerrm;
            end if;
    end;
    if not v_conflict_raised then
        raise exception 'VERIFY FAILED: a shift starting 05:00 the next day was NOT detected as overlapping the prior night''s 22:00-06:00 shift';
    end if;

    -- 5) a shift on day D+1 starting AFTER the overnight shift truly
    -- ends (07:00, after the 06:00 end) must be accepted normally
    v_row := null;
    perform assign_prosm_time_shift(v_owner, v_site, '2026-09-16'::date, '07:00'::time, '15:00'::time, null, null);

    -- 6) end_time = start_time is still correctly rejected (a
    -- zero-duration shift, never a valid overnight shift)
    begin
        perform assign_prosm_time_shift(v_owner, v_site, '2026-09-17'::date, '08:00'::time, '08:00'::time, null, null);
        raise exception 'VERIFY FAILED: a zero-duration shift (end = start) was NOT rejected';
    exception
        when others then
            if sqlerrm not ilike '%DIFFERENT FROM START TIME%' then
                raise exception 'VERIFY FAILED: wrong error for a zero-duration shift: %', sqlerrm;
            end if;
    end;

    -- cleanup: remove every trace of this verification run
    delete from notifications where related_entity_id in (select id from shift_assignments where site_id = v_site);
    delete from shift_assignments where site_id = v_site;
    delete from shift_templates where site_id = v_site;
    delete from sites where id = v_site;

    raise notice 'OVERNIGHT SHIFT SUPPORT VERIFICATION PASSED';
end;
$verify$;

commit;
