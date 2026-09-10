-- Self-cleaning live verification for 20260910140000: confirms both
-- the site_change_alert notification (via a real change_prosm_time_
-- site call) and notify_prosm_time_missing_clock_outs() actually
-- create real notification rows. All rows this creates are removed
-- before commit.
--
-- The missing-clock-out check deliberately uses an astronomically
-- high threshold (999 hours) against a session backdated to match -
-- calling it with the real default (12h) here would sweep every
-- currently-open session across every real org on this instance and
-- notify their real managers as a side effect of a verification run,
-- which this migration must never do.
do $$
declare
    v_auth_user_id uuid;
    v_user_id uuid;
    v_org_id uuid;
    v_owner_id uuid;
    v_site_id uuid;
    v_session_id uuid;
    v_result jsonb;
    v_notif_count integer;
    v_missing_count integer;
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

    select id into v_owner_id from users where organization_id = v_org_id and is_owner limit 1;
    select id into v_site_id from sites where organization_id = v_org_id and is_active = true limit 1;
    if v_owner_id is null or v_site_id is null then
        raise notice 'SKIP: no Owner or active site found in this org - verification skipped.';
        return;
    end if;

    -- ===== 1. site_change_alert =====
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at)
    values (v_org_id, v_user_id, v_site_id, 'clocked_in', now())
    returning id into v_session_id;

    perform set_config('request.jwt.claim.sub', v_auth_user_id::text, true);

    v_result := public.change_prosm_time_site(
        p_new_site_id => null,
        p_latitude => 30.0444,
        p_longitude => 31.2357,
        p_accuracy_meters => 12,
        p_manual_location_label => 'verify-sitechange-alert'
    );
    if not coalesce((v_result->>'success')::boolean, false) then
        raise exception 'VERIFICATION FAILED: change_prosm_time_site did not report success: %', v_result;
    end if;

    select count(*) into v_notif_count from notifications
    where type = 'site_change_alert' and related_entity_id = (v_result->>'siteChangeId')::uuid and user_id = v_owner_id;
    if v_notif_count < 1 then
        raise exception 'VERIFICATION FAILED: no site_change_alert notification was created for the Owner.';
    end if;
    raise notice 'VERIFIED: change_prosm_time_site creates a real site_change_alert notification.';

    delete from notifications where type = 'site_change_alert' and related_entity_id = (v_result->>'siteChangeId')::uuid;
    delete from site_change_events where attendance_session_id = v_session_id;
    delete from attendance_sessions where id = v_session_id;

    -- ===== 2. notify_prosm_time_missing_clock_outs =====
    -- Not user-scoped (no auth.uid() check inside it - a service-level
    -- sweep), so the simulated JWT claim from part 1 is irrelevant here.
    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at)
    values (v_org_id, v_user_id, v_site_id, 'clocked_in', now() - interval '1000 hours')
    returning id into v_session_id;

    select public.notify_prosm_time_missing_clock_outs(999) into v_missing_count;
    if v_missing_count < 1 then
        raise exception 'VERIFICATION FAILED: notify_prosm_time_missing_clock_outs found nothing at a 999h threshold with a 1000h-old test session present.';
    end if;

    select count(*) into v_notif_count from notifications
    where type = 'missing_clock_out' and related_entity_id = v_session_id and user_id = v_owner_id;
    if v_notif_count < 1 then
        raise exception 'VERIFICATION FAILED: no missing_clock_out notification was created for the Owner.';
    end if;
    raise notice 'VERIFIED: notify_prosm_time_missing_clock_outs() creates a real missing_clock_out notification for a genuinely stale session.';

    delete from notifications where type = 'missing_clock_out' and related_entity_id = v_session_id;
    delete from attendance_sessions where id = v_session_id;
end $$;
