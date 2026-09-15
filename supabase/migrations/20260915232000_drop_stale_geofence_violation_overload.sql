-- PROSM Time - hygiene fix, found while live-verifying 20260915230000:
-- 20260904120000's own 5-arg version of handle_prosm_time_geofence_
-- violation (no p_site_id) was never dropped when 20260904130000
-- added a 6-arg version with p_site_id - CREATE OR REPLACE with a
-- different parameter COUNT creates a second overload rather than
-- replacing the first, so both have coexisted since 2026-09-04.
-- Harmless in practice (every real call site in this codebase already
-- uses named arguments, which resolve unambiguously against the 6-arg
-- version since the 5-arg one has no p_site_id to match) - but a real
-- latent landmine for any future positional call (same class of bug
-- as the is_active_delegate_for overload ambiguity fixed 2026-09-07,
-- which broke nearly every write RPC in prosm-projects the same way).
-- A new migration, not an edit to 20260904120000/130000 or
-- 20260915230000 - none of those are safe to touch, all already
-- applied live.

begin;

drop function if exists public.handle_prosm_time_geofence_violation(uuid, uuid, double precision, uuid, uuid);

commit;
