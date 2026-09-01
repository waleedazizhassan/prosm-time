-- PROSM Time - § live UX review, user-directed, explicit authority
-- given: "the Organization Overview / Manager Console should be for
-- the Owner only, and for an Admin only for the sites they manage -
-- an Employee shouldn't see it at all."
--
-- Root cause, found by querying the live role catalog directly (not
-- guessed): the "Employee" role's own DEFAULT permission set already
-- included attendance.view - the exact permission that gates both
-- ManagerConsolePage and the Dashboard's AdminOverviewCard. This is a
-- pre-existing WP-04 role-catalog default, not something introduced
-- this session. Every other employee-facing self-service surface
-- (ClockInOutCard, "My Timesheets") already needs no permission at
-- all - self access, not attendance.view - so removing this default
-- has no effect on anything an employee is actually meant to do.
--
-- Scope: only the ROLE'S OWN default is changed here. A specific
-- individual user who was separately, explicitly granted
-- attendance.view via a user_permission_overrides row keeps it - that
-- is a deliberate per-user override, a different mechanism entirely,
-- and untouched by this migration (get_prosm_time_effective_permissions
-- already unions role defaults with granted overrides, so an existing
-- override still applies even after the role's own default changes).
--
-- Site-scoped Manager visibility ("an Admin only for the sites they're
-- responsible for") is NOT implemented here - there is no existing
-- site-to-manager assignment data model in this schema to scope
-- against (Manager Console/sites.manage are today's real, org-wide
-- gates). Building that is a genuine new feature (a site_managers
-- table, RLS changes across every site-scoped read), not a quick
-- follow-up fix, and is intentionally left out to avoid rushing a
-- half-built authorization change - Owner and Manager both keep their
-- existing org-wide visibility, Employee alone is corrected.

begin;

delete from role_default_permissions
where role_id = (select id from roles where role_key = 'employee')
and permission_id = (select id from permissions where permission_key = 'attendance.view');

commit;
