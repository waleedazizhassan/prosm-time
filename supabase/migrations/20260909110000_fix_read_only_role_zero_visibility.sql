-- PROSM Time - real bug found during a full multi-role QA pass: the
-- 'read_only' role ("Read-only / Reporting" per invite-user's own
-- ROLE_LABELS) is completely non-functional. Its default permission
-- bundle (role_default_permissions, 20260831130000) is exactly
-- 'employees.view' + 'attendance.view' + 'reports.view' - a pure,
-- org-wide reporting viewer with no site-management authority of its
-- own, by clear design intent (it has none of manager/supervisor's
-- operational permissions: no sites.manage, no exceptions.manage, no
-- *_on_behalf).
--
-- But 20260902090000 (site-scoped manager authority) later rewrote
-- every 'attendance.view'-gated SELECT policy (6 attendance-family
-- tables) plus the `sites` table's own policy to additionally require
-- site_id = any(current_prosm_time_managed_site_ids()) -
-- current_prosm_time_managed_site_ids() only returns sites where the
-- caller holds role_at_site = 'manager' (site_assignments). A
-- read_only holder is never a site manager (that would contradict
-- "read-only"), so managed_site_ids() is always empty for them, and
-- every one of those policies silently evaluates to "see nothing" -
-- confirmed live: a real read_only test account with 'attendance.view'
-- correctly present in get_prosm_time_effective_permissions() still
-- got an empty result from attendance_sessions, and could not see
-- ANY site via the sites table either.
--
-- Manager/supervisor are NOT affected by this fix and keep their exact
-- existing site-scoped behavior - the fix only adds a narrow, explicit
-- "read_only role + still holds attendance.view" exception (re-checked
-- live, not just role_key alone, so if a future admin ever strips
-- attendance.view from the read_only bundle, this exception correctly
-- stops applying too), rather than loosening the general "no managed
-- sites = unrestricted" case, which would have wrongly widened a plain
-- site member's own visibility too (e.g. a supervisor assigned to one
-- site as role_at_site='member', not 'manager', must keep seeing
-- nothing beyond their own records until actually made a site manager
-- - that scoping is correct and deliberately untouched here).

begin;

create or replace function public.current_prosm_time_user_role_key()
returns text
language sql
stable
security definer
set search_path = public
as $function$
    select r.role_key
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.auth_user_id = auth.uid();
$function$;

revoke execute on function public.current_prosm_time_user_role_key() from public, anon;
grant execute on function public.current_prosm_time_user_role_key() to authenticated;

drop policy if exists "members can view sites in own organization" on public.sites;
create policy "members can view sites in own organization"
on public.sites for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or exists (select 1 from site_assignments sa where sa.site_id = sites.id and sa.user_id = public.current_prosm_time_user_id())
        or (
            public.current_prosm_time_user_role_key() = 'read_only'
            and 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- Postgres silently truncates identifiers over 63 chars - the live
-- policy name is actually the truncated form (confirmed via pg_policies
-- before writing this), not the full text used in the original
-- `create policy` statement.
drop policy if exists "members can view their own attendance sessions or org-wide with" on public.attendance_sessions;
create policy "members can view their own attendance sessions or org-wide with attendance.view"
on public.attendance_sessions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "members can view their own attendance events or org-wide with a" on public.attendance_events;
create policy "members can view their own attendance events or org-wide with attendance.view"
on public.attendance_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = attendance_events.session_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (s.site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "camera evidence visible to subject or attendance.view" on public.camera_evidence;
create policy "camera evidence visible to subject or attendance.view"
on public.camera_evidence for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_events e
        join attendance_sessions s on s.id = e.session_id
        where e.id = camera_evidence.attendance_event_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (s.site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "correction requests visible to subject or attendance.view" on public.correction_requests;
create policy "correction requests visible to subject or attendance.view"
on public.correction_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = correction_requests.attendance_session_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (s.site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "geofence exceptions visible to subject or attendance.view" on public.geofence_exceptions;
create policy "geofence exceptions visible to subject or attendance.view"
on public.geofence_exceptions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_events e
        join attendance_sessions s on s.id = e.session_id
        where e.id = geofence_exceptions.attendance_event_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (s.site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "presence sessions visible to subject or attendance.view" on public.presence_sessions;
create policy "presence sessions visible to subject or attendance.view"
on public.presence_sessions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

commit;
