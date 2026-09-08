-- PROSM Time - self-contained, self-cleaning verification of the Xero
-- and Gusto integrations' own DB-level mechanics, mirroring
-- 20260908233000_verify_quickbooks_mechanics.sql exactly. Does NOT
-- call out to either provider's real API - neither has real
-- credentials yet. Net schema effect: zero.

begin;

do $verify$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth_id uuid;
    v_state text;
    v_resolved_org uuid;
    v_conn record;
    v_status jsonb;
    v_session_id uuid;
    v_test_site uuid;
    v_unsynced_count int;
begin
    select auth_user_id into v_owner_auth_id from users where id = v_owner;
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    insert into sites (organization_id, name, latitude, longitude, allowed_radius_meters)
    values (v_org, 'Xero Gusto Verify Temp Site', 30.0444, 31.2357, 100)
    returning id into v_test_site;

    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
    values (v_org, v_owner, v_test_site, 'clocked_out', now() - interval '9 hours', now() - interval '1 hour')
    returning id into v_session_id;

    -- ===================== XERO =====================
    perform start_prosm_time_xero_connection();
    select state into v_state from xero_oauth_states where organization_id = v_org order by created_at desc limit 1;
    if v_state is null then raise exception 'XERO VERIFY FAILED: no oauth state row was created'; end if;

    v_resolved_org := consume_prosm_time_xero_oauth_state(v_state);
    if v_resolved_org is distinct from v_org then raise exception 'XERO VERIFY FAILED: state did not resolve to the right organization'; end if;
    if exists (select 1 from xero_oauth_states where state = v_state) then raise exception 'XERO VERIFY FAILED: state row was not deleted'; end if;
    if consume_prosm_time_xero_oauth_state(v_state) is not null then raise exception 'XERO VERIFY FAILED: a consumed state was resolved twice'; end if;

    perform upsert_prosm_time_xero_connection(v_org, 'test-tenant-123', 'Test Xero Co', 'fake-access', 'fake-refresh', now() + interval '1 hour', now() + interval '60 days', v_owner);
    v_status := get_prosm_time_xero_status();
    if (v_status->>'connected')::boolean is not true or v_status->>'companyName' <> 'Test Xero Co' then
        raise exception 'XERO VERIFY FAILED: status did not reflect the upserted connection: %', v_status;
    end if;

    select * into v_conn from get_prosm_time_xero_connection_for_sync(v_org);
    if v_conn.access_token <> 'fake-access' or v_conn.tenant_id <> 'test-tenant-123' then
        raise exception 'XERO VERIFY FAILED: connection-for-sync did not return the stored tokens';
    end if;

    perform record_prosm_time_xero_token_refresh(v_org, 'rotated-access', 'rotated-refresh', now() + interval '1 hour', now() + interval '60 days');
    select * into v_conn from get_prosm_time_xero_connection_for_sync(v_org);
    if v_conn.access_token <> 'rotated-access' then raise exception 'XERO VERIFY FAILED: token refresh did not persist'; end if;

    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_xero(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 1 then raise exception 'XERO VERIFY FAILED: the completed test session was not listed as unsynced'; end if;

    perform record_prosm_time_xero_session_synced(v_session_id, 'xero-timesheet-999');
    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_xero(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 0 then raise exception 'XERO VERIFY FAILED: a marked-synced session was still listed as unsynced'; end if;

    perform record_prosm_time_xero_sync_result(v_org, jsonb_build_object('synced', 1, 'skippedNoEmployee', 0, 'failed', 0, 'unmatchedEmails', '[]'::jsonb));
    v_status := get_prosm_time_xero_status();
    if (v_status->'lastSyncSummary'->>'synced')::int <> 1 then raise exception 'XERO VERIFY FAILED: sync result was not recorded'; end if;

    perform disconnect_prosm_time_xero();
    v_status := get_prosm_time_xero_status();
    if (v_status->>'connected')::boolean is not false then raise exception 'XERO VERIFY FAILED: disconnect did not clear the connection'; end if;

    -- reset the test session's sync marker for the Gusto pass below
    update attendance_sessions set xero_synced_at = null, xero_external_id = null where id = v_session_id;

    raise notice 'XERO MECHANICS VERIFICATION PASSED';

    -- ===================== GUSTO =====================
    perform start_prosm_time_gusto_connection();
    select state into v_state from gusto_oauth_states where organization_id = v_org order by created_at desc limit 1;
    if v_state is null then raise exception 'GUSTO VERIFY FAILED: no oauth state row was created'; end if;

    v_resolved_org := consume_prosm_time_gusto_oauth_state(v_state);
    if v_resolved_org is distinct from v_org then raise exception 'GUSTO VERIFY FAILED: state did not resolve to the right organization'; end if;
    if exists (select 1 from gusto_oauth_states where state = v_state) then raise exception 'GUSTO VERIFY FAILED: state row was not deleted'; end if;
    if consume_prosm_time_gusto_oauth_state(v_state) is not null then raise exception 'GUSTO VERIFY FAILED: a consumed state was resolved twice'; end if;

    perform upsert_prosm_time_gusto_connection(v_org, 'test-company-123', 'Test Gusto Co', 'fake-access', 'fake-refresh', now() + interval '1 hour', now() + interval '60 days', v_owner);
    v_status := get_prosm_time_gusto_status();
    if (v_status->>'connected')::boolean is not true or v_status->>'companyName' <> 'Test Gusto Co' then
        raise exception 'GUSTO VERIFY FAILED: status did not reflect the upserted connection: %', v_status;
    end if;

    select * into v_conn from get_prosm_time_gusto_connection_for_sync(v_org);
    if v_conn.access_token <> 'fake-access' or v_conn.company_id <> 'test-company-123' then
        raise exception 'GUSTO VERIFY FAILED: connection-for-sync did not return the stored tokens';
    end if;

    perform record_prosm_time_gusto_token_refresh(v_org, 'rotated-access', 'rotated-refresh', now() + interval '1 hour', now() + interval '60 days');
    select * into v_conn from get_prosm_time_gusto_connection_for_sync(v_org);
    if v_conn.access_token <> 'rotated-access' then raise exception 'GUSTO VERIFY FAILED: token refresh did not persist'; end if;

    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_gusto(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 1 then raise exception 'GUSTO VERIFY FAILED: the completed test session was not listed as unsynced'; end if;

    perform record_prosm_time_gusto_session_synced(v_session_id, 'gusto-entry-999');
    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_gusto(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 0 then raise exception 'GUSTO VERIFY FAILED: a marked-synced session was still listed as unsynced'; end if;

    perform record_prosm_time_gusto_sync_result(v_org, jsonb_build_object('synced', 1, 'skippedNoEmployee', 0, 'failed', 0, 'unmatchedEmails', '[]'::jsonb));
    v_status := get_prosm_time_gusto_status();
    if (v_status->'lastSyncSummary'->>'synced')::int <> 1 then raise exception 'GUSTO VERIFY FAILED: sync result was not recorded'; end if;

    perform disconnect_prosm_time_gusto();
    v_status := get_prosm_time_gusto_status();
    if (v_status->>'connected')::boolean is not false then raise exception 'GUSTO VERIFY FAILED: disconnect did not clear the connection'; end if;

    raise notice 'GUSTO MECHANICS VERIFICATION PASSED';

    -- cleanup: remove every trace of this verification run
    delete from attendance_sessions where id = v_session_id;
    delete from sites where id = v_test_site and name = 'Xero Gusto Verify Temp Site';
    delete from xero_oauth_states where organization_id = v_org;
    delete from xero_connections where organization_id = v_org;
    delete from gusto_oauth_states where organization_id = v_org;
    delete from gusto_connections where organization_id = v_org;
end;
$verify$;

commit;
