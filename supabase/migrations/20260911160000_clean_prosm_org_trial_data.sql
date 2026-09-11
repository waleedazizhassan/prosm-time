-- User-directed production data cleanup for the real "Prosm" org
-- (cef9fc27-343d-4194-8167-033d1823b3d0): wipe real trial/testing
-- data accumulated this session (attendance, leave, timesheets,
-- allowances, notifications, SOS test alerts, external-workforce
-- kiosk test data, and the 2 leftover QA test sites + their
-- assignments). User accounts are NOT touched here - removing the one
-- specific account is done separately via the app's own real
-- Owner-only "Remove Employee" flow.
begin;

do $$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
begin
    delete from admin_on_behalf_actions where event_id in (
        select ae.id from attendance_events ae
        join attendance_sessions asn on asn.id = ae.session_id
        where asn.organization_id = v_org
    );
    delete from attendance_events where session_id in (select id from attendance_sessions where organization_id = v_org);
    delete from presence_sessions where organization_id = v_org;
    delete from attendance_sessions where organization_id = v_org;
    delete from timesheet_corrections where timesheet_id in (select id from timesheets where organization_id = v_org);
    delete from timesheets where organization_id = v_org;
    delete from leave_requests where organization_id = v_org;
    delete from allowance_entries where organization_id = v_org;
    -- geofence_exceptions/correction_requests/exception_actions all
    -- cascade automatically from attendance_events/attendance_sessions
    -- (on delete cascade) - no explicit delete needed for them.
    delete from site_change_events where organization_id = v_org;
    delete from location_plausibility_flags where organization_id = v_org;
    delete from sos_alerts where organization_id = v_org;
    delete from shift_assignments where organization_id = v_org;
    delete from notifications where organization_id = v_org;

    delete from site_worker_attendance where site_worker_id in (select id from site_workers where organization_id = v_org);
    delete from site_workers where organization_id = v_org;

    delete from site_assignments where site_id in (select id from sites where organization_id = v_org and name in ('QA Main Site', 'QA Second Site'));
    delete from shift_templates where site_id in (select id from sites where organization_id = v_org and name in ('QA Main Site', 'QA Second Site'));
    delete from sites where organization_id = v_org and name in ('QA Main Site', 'QA Second Site');
end $$;

commit;
