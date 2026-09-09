-- PROSM Time - behavioural assertions for Installation Identity, server-side
-- license enforcement, the 30-day grace period, and the protection-policy
-- update channel. Every assertion exercises the real functions; nothing here
-- passes merely because an object exists.

\set ON_ERROR_STOP on

do $$
declare
    v_reg jsonb;
    v_res jsonb;
    v_key text;
    v_secret text;
    v_key2 text;
    v_secret2 text;
    v_count integer;
begin
    -- ========================================================
    -- 1. Registration issues a server-side identity
    -- ========================================================
    v_reg := register_prosm_time_installation('android', '2.3.0', 'Test Device',
        'aaaaaaaa-0000-0000-0000-000000000001');
    v_key := v_reg->>'installationKey';
    v_secret := v_reg->>'installationSecret';

    assert (v_reg->>'success')::boolean, '1.1 registration succeeds';
    assert length(v_key) >= 20, '1.2 installation key issued by the server';
    assert length(v_secret) >= 40, '1.3 installation secret issued by the server';

    select count(*) into v_count from prosm_time_installations
    where installation_key = v_key and secret_hash = prosm_time_hash_secret(v_secret);
    assert v_count = 1, '1.4 only the hash of the secret is stored';

    select count(*) into v_count from prosm_time_installations where secret_hash = v_secret;
    assert v_count = 0, '1.5 the plaintext secret is never stored';

    select count(*) into v_count from prosm_time_security_events
    where event_type = 'INSTALLATION_REGISTERED';
    assert v_count = 1, '1.6 registration is audited';

    -- The organization is derived from the caller, never claimed by a client.
    select count(*) into v_count from prosm_time_installations
    where installation_key = v_key and organization_id = '11111111-1111-1111-1111-111111111111';
    assert v_count = 1, '1.7 organization derived server-side from the authenticated user';

    -- ========================================================
    -- 2. Valid license -> protected operations allowed
    -- ========================================================
    v_res := enforce_prosm_time_license_gate('clock-in', v_key, v_secret,
        'aaaaaaaa-0000-0000-0000-000000000001');
    assert v_res->>'state' = 'LICENSED', '2.1 active license yields LICENSED';
    assert (v_res->>'allowed')::boolean, '2.2 licensed installation may clock in';
    assert (v_res->>'graceDaysRemaining') is null, '2.3 no grace countdown for a licensed install';

    -- ========================================================
    -- 3. Forged / unknown identity is rejected
    -- ========================================================
    v_res := enforce_prosm_time_license_gate('clock-in', v_key, 'wrong-secret',
        'aaaaaaaa-0000-0000-0000-000000000001');
    assert (v_res->>'identified')::boolean is false, '3.1 wrong secret is not identified';
    assert (v_res->>'state') = 'LICENSED', '3.2 org license still governs a licensed org';

    v_res := enforce_prosm_time_license_gate('clock-in', 'no-such-key', 'no-such-secret',
        'aaaaaaaa-0000-0000-0000-000000000002');
    assert (v_res->>'allowed')::boolean is false, '3.3 unknown installation of an unlicensed org is denied';
    select count(*) into v_count from prosm_time_security_events
    where event_type = 'INSTALLATION_IDENTITY_REJECTED';
    assert v_count >= 2, '3.4 forged identities are audited';

    -- ========================================================
    -- 4. Unlicensed installation -> 30-day grace, server clock only
    -- ========================================================
    v_reg := register_prosm_time_installation('windows', '2.3.0', 'Cracked Copy',
        'aaaaaaaa-0000-0000-0000-000000000002');
    v_key2 := v_reg->>'installationKey';
    v_secret2 := v_reg->>'installationSecret';

    v_res := validate_prosm_time_installation(v_key2, v_secret2, 'aaaaaaaa-0000-0000-0000-000000000002', '2.3.0');
    assert v_res->>'state' = 'GRACE', '4.1 unlicensed installation enters the grace period';
    assert (v_res->>'allowed')::boolean, '4.2 the app keeps working during grace';
    assert (v_res->>'graceDaysRemaining')::integer = 30, '4.3 grace period is 30 days';

    select count(*) into v_count from prosm_time_installations
    where installation_key = v_key2 and grace_started_at is not null;
    assert v_count = 1, '4.4 grace start is recorded server-side';

    select count(*) into v_count from prosm_time_security_events where event_type = 'GRACE_PERIOD_STARTED';
    assert v_count = 1, '4.5 grace start is audited';

    -- A second validation must not restart the countdown.
    update prosm_time_installations set grace_started_at = now() - interval '20 days'
    where installation_key = v_key2;
    v_res := validate_prosm_time_installation(v_key2, v_secret2, 'aaaaaaaa-0000-0000-0000-000000000002', '2.3.0');
    assert (v_res->>'graceDaysRemaining')::integer = 10, '4.6 the client cannot restart the grace clock';
    select count(*) into v_count from prosm_time_security_events where event_type = 'GRACE_PERIOD_STARTED';
    assert v_count = 1, '4.7 grace start is recorded exactly once';

    -- ========================================================
    -- 5. Expired grace -> protected operations denied
    -- ========================================================
    update prosm_time_installations set grace_started_at = now() - interval '31 days'
    where installation_key = v_key2;

    v_res := enforce_prosm_time_license_gate('clock-in', v_key2, v_secret2,
        'aaaaaaaa-0000-0000-0000-000000000002');
    assert v_res->>'state' = 'UNLICENSED', '5.1 grace expiry yields UNLICENSED';
    assert (v_res->>'allowed')::boolean is false, '5.2 protected operations are denied after grace';

    select count(*) into v_count from prosm_time_security_events
    where event_type = 'PROTECTED_OPERATION_DENIED' and operation = 'clock-in';
    assert v_count >= 1, '5.3 denials are audited';

    select count(*) into v_count from prosm_time_security_events where event_type = 'GRACE_PERIOD_EXPIRED';
    assert v_count >= 1, '5.4 grace expiry is audited';

    -- Every protected PROSM Time operation uses the same gate.
    foreach v_key in array array['clock-out', 'admin-clock-in', 'admin-clock-out', 'submit-timesheet',
                                 'approve-timesheet', 'invite-user', 'export-employee-data', 'set-kiosk-pin'] loop
        v_res := enforce_prosm_time_license_gate(v_key, v_key2, v_secret2,
            'aaaaaaaa-0000-0000-0000-000000000002');
        assert (v_res->>'allowed')::boolean is false, '5.5 ' || v_key || ' denied after grace expiry';
    end loop;

    -- ========================================================
    -- 6. Suspended / revoked / expired license
    -- ========================================================
    v_reg := register_prosm_time_installation('web', '2.3.0', null, 'aaaaaaaa-0000-0000-0000-000000000003');
    v_res := enforce_prosm_time_license_gate('clock-in', v_reg->>'installationKey',
        v_reg->>'installationSecret', 'aaaaaaaa-0000-0000-0000-000000000003');
    assert v_res->>'state' = 'SUSPENDED', '6.1 suspended license yields SUSPENDED';
    assert (v_res->>'allowed')::boolean is false, '6.2 suspended license denies protected operations';

    v_reg := register_prosm_time_installation('web', '2.3.0', null, 'aaaaaaaa-0000-0000-0000-000000000004');
    v_res := enforce_prosm_time_license_gate('clock-in', v_reg->>'installationKey',
        v_reg->>'installationSecret', 'aaaaaaaa-0000-0000-0000-000000000004');
    assert v_res->>'state' = 'EXPIRED', '6.3 expired license yields EXPIRED';
    assert (v_res->>'allowed')::boolean is false, '6.4 expired license denies protected operations';

    -- ========================================================
    -- 7. Remote suspension / blocking by the control plane
    -- ========================================================
    v_reg := register_prosm_time_installation('android', '2.3.0', 'Blockable',
        'aaaaaaaa-0000-0000-0000-000000000001');
    v_key := v_reg->>'installationKey';
    v_secret := v_reg->>'installationSecret';
    perform validate_prosm_time_installation(v_key, v_secret, 'aaaaaaaa-0000-0000-0000-000000000001', '2.3.0');

    select count(*) into v_count from prosm_time_installation_sessions
    where installation_id = (select id from prosm_time_installations where installation_key = v_key)
      and ended_at is null;
    assert v_count = 1, '7.1 an active session is tracked';

    perform admin_set_prosm_time_installation_state(v_key, 'SUSPENDED', 'payment overdue');
    v_res := enforce_prosm_time_license_gate('clock-in', v_key, v_secret,
        'aaaaaaaa-0000-0000-0000-000000000001');
    assert v_res->>'state' = 'SUSPENDED', '7.2 remote suspension overrides a valid license';
    assert (v_res->>'allowed')::boolean is false, '7.3 a suspended installation is denied';

    select count(*) into v_count from prosm_time_installation_sessions
    where installation_id = (select id from prosm_time_installations where installation_key = v_key)
      and ended_at is null;
    assert v_count = 0, '7.4 suspension terminates active sessions';

    perform admin_set_prosm_time_installation_state(v_key, 'BLOCKED', 'cracked build');
    v_res := enforce_prosm_time_license_gate('clock-in', v_key, v_secret,
        'aaaaaaaa-0000-0000-0000-000000000001');
    assert v_res->>'state' = 'BLOCKED', '7.5 remote block is enforced';

    -- Recovery.
    perform admin_set_prosm_time_installation_state(v_key, 'NONE', 'reinstated');
    v_res := enforce_prosm_time_license_gate('clock-in', v_key, v_secret,
        'aaaaaaaa-0000-0000-0000-000000000001');
    assert v_res->>'state' = 'LICENSED', '7.6 reinstated installation recovers';
    select count(*) into v_count from prosm_time_security_events where event_type = 'INSTALLATION_RECOVERED';
    assert v_count >= 1, '7.7 recovery is audited';

    -- Control-plane visibility.
    v_res := list_prosm_time_installations(100);
    assert jsonb_array_length(v_res->'installations') >= 4, '7.8 installations are discoverable';
    v_res := get_prosm_time_installation_history(v_key, 50);
    assert jsonb_array_length(v_res->'events') >= 2, '7.9 per-installation security history is available';

    -- ========================================================
    -- 8. Protection-policy updates
    -- ========================================================
    v_res := get_prosm_time_protection_state();
    assert (v_res->>'activeVersion')::integer = 1, '8.1 a known-good baseline policy is active at boot';

    v_res := apply_prosm_time_protection_policy(2, jsonb_build_object('graceperioddays', 45), 'sig-2');
    assert (v_res->>'success')::boolean, '8.2 a valid signed policy activates';
    assert prosm_time_effective_grace_days() = 45, '8.3 the activated policy takes effect';

    -- Malformed / unauthorized payloads are rejected and change nothing.
    v_res := apply_prosm_time_protection_policy(3, jsonb_build_object('licenseenforcement', false), 'sig-3');
    assert (v_res->>'success')::boolean is false, '8.4 an unknown protection key is rejected';
    assert prosm_time_effective_grace_days() = 45, '8.5 a rejected update leaves the active policy intact';

    v_res := apply_prosm_time_protection_policy(4, jsonb_build_object('graceperioddays', 9999), 'sig-4');
    assert (v_res->>'success')::boolean is false, '8.6 an out-of-range value is rejected';

    v_res := apply_prosm_time_protection_policy(2, jsonb_build_object('graceperioddays', 10), 'sig-x');
    assert (v_res->>'success')::boolean is false, '8.7 replaying an old version is rejected';

    v_res := apply_prosm_time_protection_policy(5, jsonb_build_object('graceperioddays', 60), null);
    assert (v_res->>'success')::boolean is false, '8.8 an unsigned payload is rejected';

    assert (get_prosm_time_protection_state()->>'activeVersion')::integer = 2,
        '8.9 no rejected update ever becomes active';

    select count(*) into v_count from prosm_time_security_events where event_type = 'PROTECTION_UPDATE_REJECTED';
    assert v_count >= 4, '8.10 rejected updates are audited';

    select count(*) into v_count from prosm_time_protection_policies where version in (3, 4, 5);
    assert v_count = 0, '8.10b a rejected update is never staged';

    -- A control plane that is simply unreachable must change nothing.
    v_res := record_prosm_time_protection_check_failure('CONTROL_PLANE_UNREACHABLE');
    assert (get_prosm_time_protection_state()->>'activeVersion')::integer = 2,
        '8.11 an unreachable control plane never disables protection';
    assert prosm_time_effective_grace_days() = 45, '8.12 the last known-good policy stays in force offline';
    assert (get_prosm_time_protection_state()->>'lastFailureReason') = 'CONTROL_PLANE_UNREACHABLE',
        '8.13 the failed check is recorded';

    -- Enforcement still works with no network at all.
    update prosm_time_installations set grace_started_at = now() - interval '100 days'
    where installation_key = v_key2;
    v_res := enforce_prosm_time_license_gate('clock-in', v_key2, v_secret2,
        'aaaaaaaa-0000-0000-0000-000000000002');
    assert (v_res->>'allowed')::boolean is false, '8.14 enforcement is unaffected by update-check failures';

    -- Rollback restores the previous known-good version.
    v_res := rollback_prosm_time_protection_policy('activation regression');
    assert (v_res->>'success')::boolean, '8.15 rollback succeeds';
    assert (get_prosm_time_protection_state()->>'activeVersion')::integer = 1, '8.16 the previous version is restored';
    assert prosm_time_effective_grace_days() = 30, '8.17 rollback restores the previous behaviour';
    select count(*) into v_count from prosm_time_security_events where event_type = 'PROTECTION_ROLLED_BACK';
    assert v_count = 1, '8.18 rollback is audited';

    select count(*) into v_count from prosm_time_protection_policies where status = 'ACTIVE';
    assert v_count = 1, '8.19 exactly one policy is ever active';

    raise notice 'license enforcement assertions passed';
end $$;

-- ========================================================
-- 9. Privilege boundaries (no anon/authenticated access at all)
-- ========================================================
do $$
declare
    v_table text;
    v_fn text;
    v_count integer;
begin
    foreach v_table in array array['prosm_time_installations', 'prosm_time_installation_sessions',
                                   'prosm_time_security_events', 'prosm_time_protection_policies',
                                   'prosm_time_protection_runtime', 'prosm_time_license_settings'] loop
        select count(*) into v_count
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = v_table and grantee in ('anon', 'authenticated', 'PUBLIC');
        assert v_count = 0, '9.1 no client grants on ' || v_table;

        select count(*) into v_count from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity;
        assert v_count = 1, '9.2 RLS enabled on ' || v_table;
    end loop;

    foreach v_fn in array array['register_prosm_time_installation', 'validate_prosm_time_installation',
                                'enforce_prosm_time_license_gate', 'evaluate_prosm_time_installation',
                                'admin_set_prosm_time_installation_state', 'apply_prosm_time_protection_policy',
                                'rollback_prosm_time_protection_policy', 'list_prosm_time_installations',
                                'terminate_prosm_time_installation_sessions', 'get_prosm_time_protection_state'] loop
        select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = v_fn
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
        assert v_count = 0, '9.3 ' || v_fn || ' is not executable by anon/authenticated';

        select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = v_fn
          and p.prosecdef
          and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%';
        assert v_count >= 1, '9.4 ' || v_fn || ' is SECURITY DEFINER with a fixed search_path';
    end loop;

    raise notice 'privilege boundary assertions passed';
end $$;
