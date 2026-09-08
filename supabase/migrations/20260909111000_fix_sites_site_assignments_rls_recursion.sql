-- PROSM Time - CRITICAL real bug found live during the multi-role QA
-- pass, unrelated to the read_only fix in the previous migration
-- (which is what actually surfaced it - a real non-owner account
-- querying `sites` for the first time since 2026-09-02).
--
-- `sites`' own SELECT policy (20260902090000) checks
-- `exists (select 1 from site_assignments sa where sa.site_id = sites.id ...)`.
-- `site_assignments`' own SELECT policy (20260831140000, unchanged
-- since) checks `site_id in (select id from sites where organization_id = ...)`.
-- Each policy queries the OTHER table, and Postgres evaluates RLS
-- policies live per-query rather than caching a resolved plan across
-- them - querying `sites` re-triggers `site_assignments`' policy,
-- which re-triggers `sites`' policy, forever: real infinite recursion
-- (42P17), confirmed live against both a `read_only` account with zero
-- site_assignments rows AND a real `manager` account correctly
-- assigned to a site - this is NOT scoped to the read_only fix, it
-- breaks `sites` visibility for literally any authenticated non-owner
-- (Owner alone escapes it, because current_prosm_time_user_is_owner()
-- short-circuits the OR chain before the recursive branch is ever
-- evaluated - the only reason this went undetected for a week: every
-- site so far was created/viewed exclusively by the real Owner
-- account, and no genuine non-owner manager/employee session ever
-- called SiteRepository.listSites() - a direct `.from("sites")` query
-- used by SitesPage, SchedulePage's manager view, and more - until
-- this QA pass's own new manager test account did.
--
-- Fix: site_assignments' policy no longer queries `sites` at all - it
-- scopes through `users` instead (site_assignments.user_id already
-- identifies the org via users.organization_id), which has no RLS
-- dependency back on sites or site_assignments. This preserves the
-- exact same real-world scoping ("site assignments belonging to users
-- in my organization") while breaking the cycle entirely.

begin;

drop policy if exists "members can view site assignments in own organization" on public.site_assignments;
create policy "members can view site assignments in own organization"
on public.site_assignments for select to authenticated
using (
    exists (
        select 1 from users u
        where u.id = site_assignments.user_id
        and u.organization_id = public.current_prosm_time_organization_id()
    )
);

commit;
