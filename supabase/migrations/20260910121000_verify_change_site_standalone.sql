-- Self-cleaning live verification for 20260910120000: confirms
-- change_prosm_time_site now works with p_break_id => null (the new
-- standalone path), moving the caller's open session directly with no
-- break involved at all. Uses the kept QA test-employee account,
-- simulating its real session via SET LOCAL request.jwt.claim.sub.
-- All rows this creates are removed before commit.
do $$
declare
    v_auth_user_id uuid;
    v_user_id uuid;
    v_org_id uuid;
    v_site_id uuid;
    v_session_id uuid;
    v_result jsonb;
begin
    select id, auth_user_id, organization_id into v_user_id, v_auth_user_id, v_org_id
    from users where email = 'test-employee@prosm.net';

    if v_user_id is null then
        raise notice 'SKIP: test-employee@prosm.net not found - verification skipped, not failed.';
        return;
    end if;

    if exists (select 1 from attendance_sessions where user_id = v_user_id and status = 'clocked_in') then
        raise notice 'SKIP: test-employee currently has an open session - verification skipped to avoid disturbing real state.';
        return;
    end if;

    select id into v_site_id from sites where organization_id = v_org_id and is_active = true limit 1;
    if v_site_id is null then
        raise notice 'SKIP: no active site found in this org - verification skipped.';
        return;
    end if;

    -- A directly-inserted open session, standing in for a real
    -- clock-in, so this can be verified without needing a real
    -- site_assignments row for test-employee at v_site_id.
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at)
    values (v_org_id, v_user_id, v_site_id, 'clocked_in', now())
    returning id into v_session_id;

    perform set_config('request.jwt.claim.sub', v_auth_user_id::text, true);

    -- The standalone path: p_break_id omitted entirely, moving off
    -- the site to a manual "no site" location - proves the RPC no
    -- longer requires a break to move the session at all.
    v_result := public.change_prosm_time_site(
        p_new_site_id => null,
        p_latitude => 30.0444,
        p_longitude => 31.2357,
        p_accuracy_meters => 12,
        p_manual_location_label => 'verify-change-site-standalone'
    );

    if not coalesce((v_result->>'success')::boolean, false) then
        raise exception 'VERIFICATION FAILED: change_prosm_time_site did not report success: %', v_result;
    end if;

    if not exists (
        select 1 from attendance_sessions
        where id = v_session_id and site_id is null and manual_location_label = 'verify-change-site-standalone'
    ) then
        raise exception 'VERIFICATION FAILED: the session was not moved to the no-site/manual-label state.';
    end if;

    if not exists (
        select 1 from site_change_events
        where attendance_session_id = v_session_id and manual_location_label = 'verify-change-site-standalone'
    ) then
        raise exception 'VERIFICATION FAILED: no site_change_events row was recorded for the standalone move.';
    end if;

    raise notice 'VERIFIED: change_prosm_time_site moves an open session with no break at all (the new standalone Change Site path).';

    delete from site_change_events where attendance_session_id = v_session_id;
    delete from attendance_sessions where id = v_session_id;
end $$;
