-- The security tests (anonGrants) found three helpers from 20261117110000 / 20261117120000 that anyone could call
-- without signing in: prosm_time_management_sets(), prosm_time_management_own_keys(text) and
-- prosm_time_request_base_permission(text). They only return fixed lists of permission names (no data), but nothing
-- in public may be callable by anonymous visitors; signed-in people and the server keep them.
-- Rollback: grant execute on the three functions to anon.
begin;
revoke execute on function public.prosm_time_management_sets() from public, anon;
revoke execute on function public.prosm_time_management_own_keys(text) from public, anon;
revoke execute on function public.prosm_time_request_base_permission(text) from public, anon;
grant execute on function public.prosm_time_management_sets() to authenticated, service_role;
grant execute on function public.prosm_time_management_own_keys(text) to authenticated, service_role;
grant execute on function public.prosm_time_request_base_permission(text) to authenticated, service_role;
commit;
