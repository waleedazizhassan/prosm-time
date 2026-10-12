-- PROSM Time - audit 2026-10-12, item 1.1 (CRITICAL): one organisation's
-- Owner (and, for shift_assignments, any holder of schedules.manage)
-- could read another organisation's leave requests, leave entitlements
-- and shift assignments through a plain REST call (E2E T64). The
-- owner / schedules.manage shortcuts in these three SELECT policies had
-- no organisation filter. Same expressions as before (latest from
-- 20260910200000 / 20260913100000), now wrapped in an outer
-- organization_id = caller's organisation.
--
-- Check (must return 0 rows):
--   select tablename, policyname from pg_policies
--   where schemaname = 'public'
--     and (coalesce(qual,'') || coalesce(with_check,'')) ilike '%is_owner()%'
--     and (coalesce(qual,'') || coalesce(with_check,'')) not ilike '%organization_id%'
--     and (coalesce(qual,'') || coalesce(with_check,'')) not ilike '%belongs_to_caller_org%';

begin;

drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and not ('exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(leave_requests.user_id), array[]::text[])))
            and exists (
                select 1 from site_assignments sa
                where sa.user_id = leave_requests.user_id
                  and sa.site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
);

drop policy if exists "members can view own leave entitlements" on public.leave_entitlements;
create policy "members can view own leave entitlements"
on public.leave_entitlements for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and exists (
                select 1 from site_assignments sa
                where sa.user_id = leave_entitlements.user_id
                  and sa.site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
);

drop policy if exists "members can view own shift assignments" on public.shift_assignments;
create policy "members can view own shift assignments"
on public.shift_assignments for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or 'schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
    )
);

commit;
