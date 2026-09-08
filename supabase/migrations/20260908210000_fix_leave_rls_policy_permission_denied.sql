-- PROSM Time - real bug caught live with a genuine password from the
-- user (admin@prosm.net), not the migration-level auth.uid() simulation
-- this session used everywhere else that day - the very thing that
-- simulation technique cannot exercise is RLS itself (a migration runs
-- as postgres/superuser, which bypasses RLS entirely regardless of any
-- simulated auth.uid()). The very first real authenticated REST call
-- against leave_requests failed outright:
-- "permission denied for function prosm_time_user_has_permission_internal"
-- (SQLSTATE 42501) - not "returns no rows", a hard error blocking
-- EVERY select against leave_requests/leave_entitlements, even a user
-- reading their own rows.
--
-- Root cause: 20260908200000's own RLS policies called
-- prosm_time_user_has_permission_internal() directly inside their
-- USING clause - but that function is deliberately revoke-execute'd
-- from `authenticated` (20260901150000: "never exposed to PostgREST" -
-- meant to be called only from inside OTHER SECURITY DEFINER function
-- bodies, never from a client-facing RLS policy, where Postgres checks
-- the QUERYING role's own EXECUTE privilege on every function the
-- policy references). The RPCs themselves (request/review/etc.) are
-- unaffected - they call it from inside their own SECURITY DEFINER
-- bodies, a genuinely different context - only the RLS policies were
-- wrong.
--
-- Fix: the established, already-correct pattern this codebase already
-- uses for exactly this "own rows or attendance.view/supervisor" shape
-- (geofence_exceptions/correction_requests' own RLS, 20260902090000) -
-- current_prosm_time_user_is_owner() OR get_prosm_time_effective_
-- permissions(), the ONE permission-check function actually GRANTED to
-- authenticated for this purpose.

begin;

drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
);

drop policy if exists "members can view own leave entitlements" on public.leave_entitlements;
create policy "members can view own leave entitlements"
on public.leave_entitlements for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
);

commit;
