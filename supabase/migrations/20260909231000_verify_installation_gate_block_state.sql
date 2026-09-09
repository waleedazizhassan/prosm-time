-- PROSM Time - continuation of the live gate verification: inserts a
-- throwaway BLOCKED installation_identity row for the real "Prosm" org
-- so the next real HTTP call can prove the actual deny path works.
-- installation_key/secret are dummy values - the gate only ever reads
-- the cached `state` field via get_prosm_time_installation_status(),
-- it never validates the secret itself (that only matters for the
-- separate sync-installation-identity <-> Platform Management
-- handshake, not for this local-cache read).
--
-- Note: the prior migration's DELETE was already self-healed by the
-- gate's own background-resync trigger before this ran (a real,
-- working confirmation of that mechanism) - this uses an upsert
-- rather than a plain insert to force BLOCKED regardless.

begin;

insert into installation_identity (organization_id, installation_key, installation_secret, platform, app_version, state, message, last_synced_at)
values ('cef9fc27-343d-4194-8167-033d1823b3d0', 'test-verify-blocked-key', 'test-verify-blocked-secret', 'web', '2.3.0', 'BLOCKED', 'This installation is not covered by a valid license and access has been suspended. Please contact your administrator.', now())
on conflict (organization_id) do update set
    state = excluded.state,
    message = excluded.message,
    last_synced_at = excluded.last_synced_at;

commit;
