-- QA-004 (2026-11-16, found by the QA crawl on the real app): the manager's review queue read geofence_exceptions
-- and correction_requests through row policies that, for every row of the table - every organisation's rows -
-- ran a subquery into attendance_sessions and the caller's full permission list before rejecting it. Measured
-- live as a site manager: the queue's own query 1.5 s; reading the table without a filter passed the 8 s limit
-- ("canceling statement due to statement timeout"), and it grows with every organisation's data.
-- Same rule, same people see the same rows: the subject sees their own; others only inside their organisation
-- (now checked first, on the indexed organization_id - it was already required through the session) and with the
-- same owner / attendance.view + managed site / read_only conditions. The caller's id, organisation, permissions
-- and managed sites are read once per query ((select ...)), not once per row.
-- Rollback: re-create both policies from 20261018130000.

begin;

drop policy if exists "geofence exceptions visible to subject or attendance.view" on public.geofence_exceptions;
create policy "geofence exceptions visible to subject or attendance.view"
on public.geofence_exceptions for select to authenticated
using (
    user_id = (select public.current_prosm_time_user_id())
    or (
        organization_id = (select public.current_prosm_time_organization_id())
        and exists (
            select 1 from attendance_sessions s
            where s.id = coalesce(
                (select e.session_id from attendance_events e where e.id = geofence_exceptions.attendance_event_id),
                (select ps.attendance_session_id from presence_sessions ps where ps.id = geofence_exceptions.presence_session_id)
            )
            and s.organization_id = (select public.current_prosm_time_organization_id())
            and (
                (select public.current_prosm_time_user_is_owner())
                or (
                    'attendance.view' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
                    and (coalesce(s.site_id, s.responsible_site_id) = any((select public.current_prosm_time_managed_site_ids())::uuid[])
                         or (select public.current_prosm_time_user_role_key()) = 'read_only')
                )
            )
        )
    )
);

drop policy if exists "correction requests visible to subject or attendance.view" on public.correction_requests;
create policy "correction requests visible to subject or attendance.view"
on public.correction_requests for select to authenticated
using (
    user_id = (select public.current_prosm_time_user_id())
    or (
        organization_id = (select public.current_prosm_time_organization_id())
        and exists (
            select 1 from attendance_sessions s
            where s.id = correction_requests.attendance_session_id
            and s.organization_id = (select public.current_prosm_time_organization_id())
            and (
                (select public.current_prosm_time_user_is_owner())
                or (
                    'attendance.view' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
                    and (coalesce(s.site_id, s.responsible_site_id) = any((select public.current_prosm_time_managed_site_ids())::uuid[])
                         or (select public.current_prosm_time_user_role_key()) = 'read_only')
                )
            )
        )
    )
);

-- the queue filters on status: an index per organisation and status
create index if not exists geofence_exceptions_org_status_idx on public.geofence_exceptions (organization_id, status);
create index if not exists correction_requests_org_status_idx on public.correction_requests (organization_id, status);

commit;
