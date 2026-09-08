-- PROSM Time - one-time, user-requested data reset for the real "Prosm"
-- organization (id cef9fc27-343d-4194-8167-033d1823b3d0), ahead of the
-- first real release. User's own words: "نضف كل البيانات اللي جوة شركة
-- بروسم في بروسم تايم عايز بس فيها ايميل admin@prosm.net خليها نضيفة
-- خالص" - wipe every accumulated dev/test record for this org, keep
-- exactly one user (admin@prosm.net, the existing Owner - untouched),
-- with zero attached history of any kind, including hers.
--
-- Explicitly confirmed with the user before running:
-- - Which org: this exact one (the same org used for all live testing
--   this session - employee "Lido" / waleedelnhrawee@gmail.com).
-- - Scope: everything (employees other than admin@prosm.net, all
--   attendance/timesheet/allowance history, all exceptions/SOS/
--   notifications, sites and projects too).
-- - admin@prosm.net stays exactly as-is (Owner, same row) - not
--   recreated, not touched.
-- - Real conflict surfaced and resolved: 3 admin_on_behalf_actions rows
--   (RESTRICT-guarded audit trail of admin@prosm.net clocking Lido in/
--   out earlier today, for the presence-session bug fix) would have
--   blocked Lido's removal through the app's own safe remove-employee
--   flow ("This employee reviewed or approved records for other
--   employees - removing them would destroy that history. Deactivate
--   them instead."). User explicitly chose to override this and destroy
--   that audit trail too, rather than deactivate Lido and keep it.
--
-- This is a manual one-time reset for one specific, real organization -
-- not a repeatable data-repair pattern. Every statement below is scoped
-- by this org's literal id (and is a no-op on any other environment/
-- organization, including a fresh install, since this exact org id
-- won't exist there).

begin;

do $$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_admin_id uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_deleted integer;
begin
    -- Phase A: clear RESTRICT-guarded tables first (they block deleting
    -- the users/attendance_sessions/attendance_events rows they
    -- reference - admin_on_behalf_actions.subject_user_id/actor_user_id,
    -- session_id and event_id are all ON DELETE RESTRICT; exception_
    -- actions/timesheet_approvals/timesheet_corrections restrict on
    -- their own actor/requested_by reference).
    delete from admin_on_behalf_actions where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'admin_on_behalf_actions deleted: %', v_deleted;

    delete from exception_actions where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'exception_actions deleted: %', v_deleted;

    delete from timesheet_approvals where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'timesheet_approvals deleted: %', v_deleted;

    delete from timesheet_corrections where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'timesheet_corrections deleted: %', v_deleted;

    -- Phase B: every other org-scoped operational/data table, in full -
    -- covers admin@prosm.net's own rows too (her users row is kept, so
    -- nothing would otherwise cascade-clean her own history).
    delete from geofence_exceptions where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'geofence_exceptions deleted: %', v_deleted;

    delete from correction_requests where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'correction_requests deleted: %', v_deleted;

    delete from sos_alerts where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'sos_alerts deleted: %', v_deleted;

    -- Storage objects for these rows (camera-evidence bucket) are NOT
    -- removed here - plain SQL cannot touch Storage, only the service
    -- role via the Storage API can. The DB rows referencing them are
    -- gone after this, so the app will never surface them again; the
    -- underlying files become orphaned bytes in private storage (a
    -- known, separately-flagged follow-up, not a blocker for this
    -- reset).
    delete from camera_evidence where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'camera_evidence deleted: %', v_deleted;

    delete from notifications where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'notifications deleted: %', v_deleted;

    delete from audit_logs where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'audit_logs deleted: %', v_deleted;

    delete from break_events where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'break_events deleted: %', v_deleted;

    delete from presence_sessions where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'presence_sessions deleted: %', v_deleted;

    delete from site_change_events where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'site_change_events deleted: %', v_deleted;

    delete from allowance_entries where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'allowance_entries deleted: %', v_deleted;

    delete from timesheets where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'timesheets deleted: %', v_deleted;

    -- attendance_events has no organization_id column of its own -
    -- scoped via its parent session instead.
    delete from attendance_events where session_id in (select id from attendance_sessions where organization_id = v_org);
    get diagnostics v_deleted = row_count; raise notice 'attendance_events deleted: %', v_deleted;

    delete from attendance_sessions where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'attendance_sessions deleted: %', v_deleted;

    -- Sites cascade to projects/site_assignments/project_assignments
    -- automatically (all ON DELETE CASCADE from sites(id)) - no
    -- separate statements needed for those.
    delete from sites where organization_id = v_org;
    get diagnostics v_deleted = row_count; raise notice 'sites (and cascaded projects/assignments) deleted: %', v_deleted;

    -- Phase C: remove every user except admin@prosm.net. Real Supabase
    -- Auth accounts (auth.users) are deleted directly too, since this
    -- is plain SQL with full database privileges (unlike the client-side
    -- remove-employee Edge Function, which needs auth.admin.deleteUser
    -- specifically because it only has an ordinary user's session, not
    -- a raw DB connection) - auth.users.id -> public.users.auth_user_id
    -- is ON DELETE CASCADE, so this also removes their public.users row.
    delete from auth.users where id in (
        select auth_user_id from users where organization_id = v_org and id <> v_admin_id
    );
    get diagnostics v_deleted = row_count; raise notice 'auth.users (and cascaded public.users) deleted: %', v_deleted;

    -- Safety net in case any non-admin public.users row somehow had no
    -- matching auth.users row (should never happen, but this must not
    -- silently leave a stray profile behind).
    delete from users where organization_id = v_org and id <> v_admin_id;
    get diagnostics v_deleted = row_count; raise notice 'stray public.users rows deleted: %', v_deleted;
end $$;

commit;
