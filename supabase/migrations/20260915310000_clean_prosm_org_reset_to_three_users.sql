-- PROSM Time - user-directed real production data cleanup (2026-09-15,
-- explicitly confirmed via a clarifying question before running this):
-- the "Prosm" organization (cef9fc27-343d-4194-8167-033d1823b3d0) is
-- being reset to a clean, real-use-ready state now that this whole
-- session's testing/verification work is complete.
--
-- 1. Remove the 4 QA test accounts entirely (Employee/Manager/
--    ReadOnly/Supervisor from the 2026-09-09 multi-role QA pass) -
--    deleting their real auth.users rows, which cascades through
--    public.users -> every table with a user_id FK (attendance,
--    leave, notifications, timesheets, allowances, shift assignments,
--    presence sessions, sos alerts, geofence exceptions, device
--    bindings, invitations, site assignments) automatically.
-- 2. Wipe ALL remaining transactional/history data for the 3 kept
--    accounts (Owner admin@prosm.net, Lido, "U u") - attendance,
--    leave, timesheets, notifications, allowances, shift assignments,
--    presence sessions (which cascades geofence_exceptions/sos_alerts
--    via their own FKs), report exports (DB rows + the matching
--    Storage objects). User confirmed explicitly: "امسح كل حاجة،
--    رجّعها نضيفة تمامًا."
--
-- Explicitly NOT touched (structural/config, not "data" in the sense
-- asked about): organizations, sites, site_assignments, api_keys,
-- roles/permissions, payroll_settings-equivalent site policy columns.
-- The 3 kept accounts remain fully functional (still assigned to
-- their sites, still have valid logins) with a clean history.
do $cleanup$
declare
    v_org_id uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_qa_auth_ids uuid[] := array[
        'c7684b2e-711b-406f-beb7-50f20d5cd872', -- placeholder, overwritten below (kept for readability only)
        'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc'  -- placeholder, overwritten below (kept for readability only)
    ];
    v_deleted_users integer;
    v_deleted_row_count integer;
begin
    -- Real auth_user_ids for the 4 QA accounts (confirmed via
    -- 20260915291000's own diagnostic output), not the Owner/Lido/uu
    -- ones accidentally placeholder'd above - overwritten with the
    -- real, verified list right here so there is exactly one source
    -- of truth in this statement.
    v_qa_auth_ids := array[
        '92ce59c2-ce62-41c4-a7d5-7f4416bda060', -- QA Test Manager
        'ff2095a6-2f65-4cec-b99e-8d63682de741', -- QA Test ReadOnly
        'fbac0fc8-0796-4367-a8ca-4b33667d6800', -- QA Test Supervisor
        'f8f8c181-fa33-457a-810e-0ad429a5efc6'  -- QA Test Employee
    ];

    delete from auth.users where id = any(v_qa_auth_ids);
    get diagnostics v_deleted_users = row_count;
    if v_deleted_users <> 4 then
        raise exception 'CLEANUP FAILED: expected to delete 4 auth.users rows, deleted %', v_deleted_users;
    end if;
    raise notice 'Deleted % QA test accounts (cascaded to all their data)', v_deleted_users;

    -- Remaining transactional data for the 3 kept accounts.
    delete from notifications where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % notifications', v_deleted_row_count;

    delete from geofence_exceptions where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % geofence_exceptions (any not already cascaded)', v_deleted_row_count;

    delete from sos_alerts where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % sos_alerts (any not already cascaded)', v_deleted_row_count;

    delete from leave_requests where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % leave_requests', v_deleted_row_count;

    delete from timesheets where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % timesheets', v_deleted_row_count;

    delete from allowance_entries where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % allowance_entries', v_deleted_row_count;

    delete from shift_assignments where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % shift_assignments', v_deleted_row_count;

    -- Note: report-exports Storage objects are NOT deleted here -
    -- Postgres blocks direct DELETE against storage.objects ("Direct
    -- deletion from storage tables is not allowed. Use the Storage
    -- API instead.", confirmed live). The DB rows below are still
    -- removed; any orphaned PDF files in the bucket are a separate,
    -- low-stakes cleanup (a handful of test PDFs, no functional
    -- impact) left for a follow-up Storage API call, not blocking
    -- this data cleanup.
    delete from report_exports where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % report_exports rows', v_deleted_row_count;

    delete from presence_sessions where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % presence_sessions (cascades any remaining sos_alerts)', v_deleted_row_count;

    -- admin_on_behalf_actions.session_id/event_id are ON DELETE
    -- RESTRICT (an audit trail, deliberately not cascade-deletable in
    -- normal app operation) - found live when attendance_sessions
    -- below first errored on this FK. Must clear first for a full
    -- reset.
    delete from admin_on_behalf_actions where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % admin_on_behalf_actions', v_deleted_row_count;

    delete from attendance_sessions where organization_id = v_org_id;
    get diagnostics v_deleted_row_count = row_count;
    raise notice 'Deleted % attendance_sessions (cascades attendance_events + any remaining presence_sessions/geofence_exceptions)', v_deleted_row_count;

    raise notice 'CLEANUP COMPLETE: org % now holds only the 3 kept accounts with no history', v_org_id;
end;
$cleanup$;
