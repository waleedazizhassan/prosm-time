-- PROSM Time - real bug caught by the just-run real-data verification
-- (20260913241000): an employee personally assigned to a project but
-- with NO site_assignments row at all (the exact real "Lido" account
-- this whole audit was run against) could not see that project even
-- via the explicit current_prosm_time_caller_assigned_to_project()
-- exception - "EMPLOYEE (Lido) sees the test project she is personally
-- assigned to: 0 (expect: 1)".
--
-- Root cause: projects' policy gated everything behind
-- `site_id in (select id from sites where organization_id = ...)` -
-- that subquery runs under the CALLER's own RLS on `sites` (it is a
-- plain subquery, not a SECURITY DEFINER read), and `sites`' own
-- policy requires a real site_assignments row (or Owner, or read_only)
-- to see ANY site at all. An employee with zero site_assignments -
-- exactly the case a bare project assignment with no site membership
-- is supposed to cover - sees zero rows from `sites`, so the outer
-- `in (...)` was always empty and always false, regardless of the
-- assigned-to-this-project exception meant to grant access.
--
-- Fixed by reusing current_prosm_time_project_belongs_to_caller_org()
-- (already added in 20260913231000 for project_assignments' own org
-- check) instead of the inline sites subquery - it is SECURITY
-- DEFINER, so it resolves the project's real organization by reading
-- `sites` under its own elevated privilege, never the caller's.

begin;

drop policy if exists "members can view projects in own organization" on public.projects;
create policy "members can view projects in own organization"
on public.projects for select to authenticated
using (
    public.current_prosm_time_project_belongs_to_caller_org(id)
    and (
        public.current_prosm_time_user_is_owner()
        or site_id = any(public.current_prosm_time_managed_site_ids())
        or public.current_prosm_time_caller_assigned_to_project(id)
    )
);

commit;
