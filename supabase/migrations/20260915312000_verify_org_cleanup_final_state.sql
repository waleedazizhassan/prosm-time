-- PROSM Time - diagnostic only, confirms 20260915310000's cleanup
-- left exactly the 3 intended users and zero residual data.
do $verify$
declare
    v_org_id uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_row record;
    v_user_count integer;
    v_residual record;
    v_any_residual boolean := false;
begin
    select count(*) into v_user_count from users where organization_id = v_org_id;
    raise notice 'USER COUNT: % (expected 3)', v_user_count;

    for v_row in select full_name, email, is_owner from users where organization_id = v_org_id order by is_owner desc, full_name loop
        raise notice 'REMAINING USER: % <%> owner=%', v_row.full_name, v_row.email, v_row.is_owner;
    end loop;

    for v_residual in
        select 'notifications' as t, count(*) c from notifications where organization_id = v_org_id
        union all select 'leave_requests', count(*) from leave_requests where organization_id = v_org_id
        union all select 'timesheets', count(*) from timesheets where organization_id = v_org_id
        union all select 'allowance_entries', count(*) from allowance_entries where organization_id = v_org_id
        union all select 'shift_assignments', count(*) from shift_assignments where organization_id = v_org_id
        union all select 'report_exports', count(*) from report_exports where organization_id = v_org_id
        union all select 'presence_sessions', count(*) from presence_sessions where organization_id = v_org_id
        union all select 'admin_on_behalf_actions', count(*) from admin_on_behalf_actions where organization_id = v_org_id
        union all select 'attendance_sessions', count(*) from attendance_sessions where organization_id = v_org_id
        union all select 'geofence_exceptions', count(*) from geofence_exceptions where organization_id = v_org_id
        union all select 'sos_alerts', count(*) from sos_alerts where organization_id = v_org_id
    loop
        raise notice 'RESIDUAL % : % rows', v_residual.t, v_residual.c;
        if v_residual.c > 0 then v_any_residual := true; end if;
    end loop;

    if v_any_residual then
        raise notice 'WARNING: some residual data remains, see above';
    else
        raise notice 'CONFIRMED: zero residual transactional data across all checked tables';
    end if;
end;
$verify$;
