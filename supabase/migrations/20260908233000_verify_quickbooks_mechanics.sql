-- PROSM Time - self-contained, self-cleaning verification of the
-- QuickBooks integration's own DB-level mechanics (state minting/
-- consumption, connection upsert/read, unsynced-session listing,
-- sync-result recording). Does NOT call out to Intuit's real API -
-- that can only be verified live, through the actual Settings UI, with
-- a real OAuth round trip. Net schema effect: zero either way.

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
    -- current_prosm_time_user_id() matches public.users.auth_user_id =
    -- auth.uid() - look this up rather than assuming v_owner (the
    -- public.users.id) equals the auth id.
    select auth_user_id into v_owner_auth_id from users where id = v_owner;
    if v_owner_auth_id is null then
        raise exception 'VERIFY SETUP FAILED: could not resolve admin@prosm.net auth_user_id';
    end if;

    -- simulate an authenticated owner session for the RPCs that check
    -- auth.uid()/is_owner directly
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    -- 1) start_prosm_time_quickbooks_connection mints a real state row
    perform start_prosm_time_quickbooks_connection();
    select state into v_state from quickbooks_oauth_states where organization_id = v_org order by created_at desc limit 1;
    if v_state is null then
        raise exception 'VERIFY FAILED: no oauth state row was created';
    end if;

    -- 2) consume_prosm_time_quickbooks_oauth_state resolves + deletes it
    v_resolved_org := consume_prosm_time_quickbooks_oauth_state(v_state);
    if v_resolved_org is distinct from v_org then
        raise exception 'VERIFY FAILED: state did not resolve to the right organization';
    end if;
    if exists (select 1 from quickbooks_oauth_states where state = v_state) then
        raise exception 'VERIFY FAILED: state row was not deleted after being consumed';
    end if;
    -- a second consume of the same (now-deleted) state must fail closed
    if consume_prosm_time_quickbooks_oauth_state(v_state) is not null then
        raise exception 'VERIFY FAILED: a consumed state was resolved a second time';
    end if;

    -- 3) upsert_prosm_time_quickbooks_connection stores a connection,
    -- and get_prosm_time_quickbooks_status reports it without ever
    -- exposing the raw tokens
    perform upsert_prosm_time_quickbooks_connection(
        v_org, 'test-realm-123', 'Test Sandbox Co', 'fake-access-token', 'fake-refresh-token',
        now() + interval '1 hour', now() + interval '100 days', v_owner
    );
    v_status := get_prosm_time_quickbooks_status();
    if (v_status->>'connected')::boolean is not true or v_status->>'companyName' <> 'Test Sandbox Co' then
        raise exception 'VERIFY FAILED: status did not reflect the upserted connection: %', v_status;
    end if;
    if v_status ? 'accessToken' or v_status ? 'access_token' then
        raise exception 'VERIFY FAILED: status leaked a raw token field';
    end if;

    -- 4) get_prosm_time_quickbooks_connection_for_sync (service-role
    -- surface) returns the real stored tokens
    select * into v_conn from get_prosm_time_quickbooks_connection_for_sync(v_org);
    if v_conn.access_token <> 'fake-access-token' or v_conn.realm_id <> 'test-realm-123' then
        raise exception 'VERIFY FAILED: connection-for-sync did not return the stored tokens';
    end if;

    -- 5) record_prosm_time_quickbooks_token_refresh updates in place
    perform record_prosm_time_quickbooks_token_refresh(v_org, 'rotated-access', 'rotated-refresh', now() + interval '1 hour', now() + interval '100 days');
    select * into v_conn from get_prosm_time_quickbooks_connection_for_sync(v_org);
    if v_conn.access_token <> 'rotated-access' or v_conn.refresh_token <> 'rotated-refresh' then
        raise exception 'VERIFY FAILED: token refresh did not persist';
    end if;

    -- 6) list_prosm_time_unsynced_sessions_for_quickbooks finds a real
    -- completed session and excludes an already-synced one
    select id into v_test_site from sites where organization_id = v_org limit 1;
    if v_test_site is null then
        insert into sites (organization_id, name, latitude, longitude, allowed_radius_meters)
        values (v_org, 'QB Verify Temp Site', 30.0444, 31.2357, 100)
        returning id into v_test_site;
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
    values (v_org, v_owner, v_test_site, 'clocked_out', now() - interval '9 hours', now() - interval '1 hour')
    returning id into v_session_id;

    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_quickbooks(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 1 then
        raise exception 'VERIFY FAILED: the completed test session was not listed as unsynced';
    end if;

    perform record_prosm_time_quickbooks_session_synced(v_session_id, 'qb-time-activity-999');
    select count(*) into v_unsynced_count from list_prosm_time_unsynced_sessions_for_quickbooks(v_org, 50) where session_id = v_session_id;
    if v_unsynced_count <> 0 then
        raise exception 'VERIFY FAILED: a marked-synced session was still listed as unsynced';
    end if;

    -- 7) record_prosm_time_quickbooks_sync_result + disconnect
    perform record_prosm_time_quickbooks_sync_result(v_org, jsonb_build_object('synced', 1, 'skippedNoEmployee', 0, 'failed', 0, 'unmatchedEmails', '[]'::jsonb));
    v_status := get_prosm_time_quickbooks_status();
    if (v_status->'lastSyncSummary'->>'synced')::int <> 1 then
        raise exception 'VERIFY FAILED: sync result was not recorded';
    end if;

    perform disconnect_prosm_time_quickbooks();
    v_status := get_prosm_time_quickbooks_status();
    if (v_status->>'connected')::boolean is not false then
        raise exception 'VERIFY FAILED: disconnect did not clear the connection';
    end if;

    -- cleanup: remove every trace of this verification run
    delete from attendance_sessions where id = v_session_id;
    if v_test_site is not null then
        delete from sites where id = v_test_site and name = 'QB Verify Temp Site';
    end if;
    delete from quickbooks_oauth_states where organization_id = v_org;
    delete from quickbooks_connections where organization_id = v_org;

    raise notice 'QUICKBOOKS MECHANICS VERIFICATION PASSED';
end;
$verify$;

commit;
