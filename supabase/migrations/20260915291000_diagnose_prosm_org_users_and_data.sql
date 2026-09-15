-- PROSM Time - diagnostic only, no schema/data changes. Identifying
-- the exact real user rows and data volume in the "Prosm" organization
-- before any cleanup, per the user's request (2026-09-15): keep only
-- the Owner + "uu" + "Lido", remove every other user, and clear org
-- data. Need to know EXACTLY which real rows those 3 names resolve to
-- before writing any delete statement.
do $diag$
declare
    v_org_id uuid;
    v_row record;
    v_table_count record;
begin
    select id into v_org_id from organizations where name ilike '%prosm%' limit 1;
    if v_org_id is null then
        raise exception 'DIAG FAILED: no organization matching %%prosm%% found';
    end if;
    raise notice 'ORG: id=%', v_org_id;

    for v_row in
        select id, full_name, email, is_owner, status, auth_user_id
        from users where organization_id = v_org_id order by is_owner desc, full_name
    loop
        raise notice 'USER id=% name=% email=% is_owner=% status=% auth_user_id=%',
            v_row.id, v_row.full_name, v_row.email, v_row.is_owner, v_row.status, v_row.auth_user_id;
    end loop;

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
        union all select 'user_invitations', count(*) from user_invitations ui join users u on u.id = ui.user_id where u.organization_id = v_org_id
    loop
        raise notice 'TABLE % : % rows', v_table_count.t, v_table_count.c;
    end loop;
end;
$diag$;
