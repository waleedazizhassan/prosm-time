-- PROSM Time - temporary state manipulation for a real, live gate
-- verification (Anti-Crack enforcement phase). Deletes the real
-- "Prosm" org's installation_identity row so the next real HTTP call
-- can prove the fail-open behavior for "no record at all." This is
-- deliberately NOT wrapped in a self-contained transaction with the
-- test HTTP call in between (a real Edge Function invocation cannot
-- happen inside a SQL migration) - the row is restored to its true,
-- authoritative state by a real sync-installation-identity call
-- immediately after the verification curl calls in
-- 20260909231000_verify_installation_gate_restore.sql.

begin;

delete from installation_identity where organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0';

commit;
