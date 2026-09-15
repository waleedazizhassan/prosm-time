-- PROSM Time - final residue check: confirm the entire regression
-- sweep left the real "Prosm" org's data volumes unchanged from the
-- pre-sweep baseline captured in 20260915291000.
do $verify$
declare
    v_org_id uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_table_count record;
begin
    for v_table_count in
        select 'sites' as t, count(*) c from sites where organization_id = v_org_id
        union all select 'attendance_sessions', count(*) from attendance_sessions where organization_id = v_org_id
        union all select 'attendance_events', count(*) from attendance_events ae join users u on u.id = ae.user_id where u.organization_id = v_org_id
        union all select 'leave_requests', count(*) from leave_requests lr join users u on u.id = lr.user_id where u.organization_id = v_org_id
        union all select 'notifications', count(*) from notifications where organization_id = v_org_id
        union all select 'geofence_exceptions', count(*) from geofence_exceptions where organization_id = v_org_id
        union all select 'timesheets', count(*) from timesheets where organization_id = v_org_id
        union all select 'allowance_entries', count(*) from allowance_entries where organization_id = v_org_id
        union all select 'shift_assignments', count(*) from shift_assignments sa join users u on u.id = sa.user_id where u.organization_id = v_org_id
        union all select 'presence_sessions', count(*) from presence_sessions ps join users u on u.id = ps.user_id where u.organization_id = v_org_id
        union all select 'sos_alerts', count(*) from sos_alerts where organization_id = v_org_id
        union all select 'report_exports', count(*) from report_exports where organization_id = v_org_id
        union all select 'device_bindings', count(*) from device_bindings db join users u on u.id = db.user_id where u.organization_id = v_org_id
        union all select 'api_keys', count(*) from api_keys where organization_id = v_org_id
        union all select 'admin_on_behalf_actions', count(*) from admin_on_behalf_actions where organization_id = v_org_id
        union all select 'site_assignments', count(*) from site_assignments sa2 join users u on u.id = sa2.user_id where u.organization_id = v_org_id
    loop
        raise notice 'TABLE % : % rows (post-sweep)', v_table_count.t, v_table_count.c;
    end loop;
end;
$verify$;
