-- PROSM Time - real user report: an account with role_key = 'manager'
-- assigned to exactly ONE site could still see people who aren't
-- assigned to ANY site at all - visibility that should be Owner-only.
--
-- Root cause: the `users` table's own SELECT RLS policy
-- ("members can view users in own organization", 20260831110000) is
-- from the earliest foundational schema migration and predates the
-- entire "a Manager's authority is scoped to the sites they actually
-- manage" initiative (20260902090000 and everything built on top of it
-- since). It was never tightened - any authenticated org member can
-- read every `users` row in the organization, completely unscoped.
--
-- 20260902090000 deliberately worked around this by adding a dedicated
-- SECURITY DEFINER RPC (list_prosm_time_visible_members()) for the
-- People list instead of tightening this policy directly, on the
-- stated reasoning that "many other flows... rely on [the] broad 'same
-- organization' policy... and must keep working exactly as they do
-- today." That reasoning is exactly why this table's RLS was left
-- alone for so long, but it is also exactly the bug: `list_prosm_time_
-- visible_members()` is SECURITY DEFINER (bypasses RLS, enforces its
-- own scope in its WHERE clause), so the People list itself was never
-- actually exposed to this hole - but ANY other code path in the app
-- that reads `public.users` directly (a plain `.from("users")` query,
-- or a `users(full_name)`-style embedded join in a repository's
-- `.select()`) inherits the unscoped table policy directly and leaks
-- every org member's name/email/status regardless of the caller's own
-- site scope. Confirmed real client-side leak surfaces:
-- ManagerRepository's "Currently Present"/history roster and
-- pending-review list (attendance_sessions/geofence_exceptions/
-- correction_requests joins), AllowanceRepository, TimesheetRepository,
-- LeaveRepository, ProjectRepository, SiteRepository (all
-- `users!..._fkey(...)` embeds).
--
-- Fix: replace the table's own SELECT policy with the exact same scope
-- list_prosm_time_visible_members() already enforces - self, always;
-- the Owner, everything; anyone else, only a non-Owner user who has a
-- real site_assignments row at one of the caller's own managed sites
-- (current_prosm_time_managed_site_ids(), 20260902090000).
--
-- Two additive exceptions, both real, both traced against the actual
-- underlying table's own RLS before being added here - not invented:
--
--   1. SOS/emergency alerts (sos_alerts, reinforced today in
--      20260910200000) are deliberately kept ORG-WIDE for any
--      attendance.view holder, not site-scoped - "SOS is a safety
--      feature where restricting visibility to your own site only
--      could delay a real emergency response." ManagerRepository.
--      listSosAlerts() joins `users!sos_alerts_user_id_fkey(full_name,
--      email)` for the alerting employee - without this exception, the
--      new stricter `users` policy would silently null out that name
--      for a Manager whose own managed site doesn't match the
--      alerter's, defeating that already-correct, already-shipped
--      design decision. Mirrors sos_alerts' own RLS condition exactly.
--
--   2. A "walk-in" clock-in (20260903170000: an employee clocking in
--      at an unassigned-but-in-range geofenced site) deliberately never
--      persists a site_assignments row ("this is a one-time walk-in,
--      not a permanent assignment"). The attendance-family RLS
--      (20260902090000) already lets a Manager see that walk-in's own
--      attendance_sessions/correction_requests/geofence_exceptions row
--      once it happens at one of their managed sites (scoped by
--      site_id, not by site_assignments) - so without this exception,
--      ManagerRepository's roster (fetchAttendanceRows, `users(full_
--      name)`) and pending-review list (`users(full_name)` on
--      geofence_exceptions/correction_requests) would show a real,
--      already-legitimately-visible row with a silently blank name the
--      moment a walk-in employee had zero site_assignments rows
--      anywhere. Mirrors the attendance_sessions policy's own
--      site+attendance.view condition exactly - grants nothing beyond
--      what that table's RLS already exposes to the same caller.
--
-- No other exception added - every other `users(...)` embed found in
-- src/core/repositories (Leave/Timesheet/Site/ProjectRepository) reads
-- off a base table whose own RLS already requires a real
-- site_assignments row for the subject employee at one of the caller's
-- managed sites, so the site-scoped branch above already covers them.
--
-- CRITICAL implementation note - real infinite recursion hit and fixed
-- within this same migration before ever leaving this session:
-- `site_assignments`' own SELECT policy (20260909111000, a previous
-- real recursion fix) resolves its own scope via
-- `exists (select 1 from users u where u.id = site_assignments.user_id ...)`.
-- A first draft of this migration's `users` policy queried
-- `site_assignments` directly in its own USING clause - `users` -> RLS
-- re-evaluates `site_assignments` -> RLS re-evaluates `users` -> ...,
-- the exact same A<->B cycle shape 20260909111000 already documents,
-- just on the `users`<->`site_assignments` pair instead of
-- `sites`<->`site_assignments`. Fixed the same way that migration
-- fixed it, and the same way current_prosm_time_managed_site_ids()
-- already avoids it for every OTHER table's policy in this schema:
-- every table this policy needs to check (site_assignments, sos_alerts,
-- attendance_sessions) is read from inside a SECURITY DEFINER helper
-- function, never inline in the policy body, so the read happens under
-- the function's own elevated privilege (bypassing RLS entirely) and
-- never re-enters `users`' or any other table's row-level security.

begin;

create or replace function public.current_prosm_time_caller_manages_users_site(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from site_assignments sa
        where sa.user_id = p_target_user_id
        and sa.site_id = any(public.current_prosm_time_managed_site_ids())
    );
$function$;

revoke all on function public.current_prosm_time_caller_manages_users_site(uuid) from public, anon;
grant execute on function public.current_prosm_time_caller_manages_users_site(uuid) to authenticated;

create or replace function public.current_prosm_time_caller_sees_users_sos_alert(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    -- Mirrors "sos alerts visible to subject or attendance.view"
    -- (20260910200000) exactly: org-wide, no site scoping.
    select exists (
        select 1 from sos_alerts sa
        where sa.user_id = p_target_user_id
        and sa.organization_id = public.current_prosm_time_organization_id()
    );
$function$;

revoke all on function public.current_prosm_time_caller_sees_users_sos_alert(uuid) from public, anon;
grant execute on function public.current_prosm_time_caller_sees_users_sos_alert(uuid) to authenticated;

create or replace function public.current_prosm_time_caller_sees_users_attendance(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    -- Mirrors the attendance_sessions policy's own "site_id in the
    -- caller's managed sites" condition (20260902090000) exactly.
    select exists (
        select 1 from attendance_sessions s
        where s.user_id = p_target_user_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and s.site_id = any(public.current_prosm_time_managed_site_ids())
    );
$function$;

revoke all on function public.current_prosm_time_caller_sees_users_attendance(uuid) from public, anon;
grant execute on function public.current_prosm_time_caller_sees_users_attendance(uuid) to authenticated;

drop policy if exists "members can view users in own organization" on public.users;

create policy "members can view users at their own scope"
on public.users for select to authenticated
using (
    id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (not is_owner and public.current_prosm_time_caller_manages_users_site(id))
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and public.current_prosm_time_caller_sees_users_sos_alert(id)
            )
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and public.current_prosm_time_caller_sees_users_attendance(id)
            )
        )
    )
);

commit;
