-- PROSM Time - investigating item 1 of the user's own report: "clocked
-- in today, stayed put, but got an out-of-zone message later." Find
-- the real exception row(s) from today for the real org and dump the
-- real distance/accuracy/site data behind it.

begin;

do $diagnose$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_row record;
begin
    for v_row in
        select
            ge.id, ge.user_id, u.email, ge.distance_meters, ge.created_at,
            ge.attendance_event_id, ge.presence_session_id,
            s.name as site_name, s.allowed_radius_meters, s.gps_accuracy_tolerance_meters
        from geofence_exceptions ge
        join users u on u.id = ge.user_id
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        left join attendance_sessions ats on ats.id = coalesce(ae.session_id, ps.attendance_session_id)
        left join sites s on s.id = ats.site_id
        where ge.organization_id = v_org
        and ge.created_at::date = current_date
        order by ge.created_at desc
    loop
        raise notice 'exception id=% user=% distance=%m site=%(radius=%m,tolerance=%m) created=% event_id=% presence_id=%',
            v_row.id, v_row.email, v_row.distance_meters, v_row.site_name, v_row.allowed_radius_meters, v_row.gps_accuracy_tolerance_meters, v_row.created_at, v_row.attendance_event_id, v_row.presence_session_id;
    end loop;

    raise notice '--- also check yesterday in case of timezone confusion ---';
    for v_row in
        select ge.id, u.email, ge.distance_meters, ge.created_at
        from geofence_exceptions ge join users u on u.id = ge.user_id
        where ge.organization_id = v_org and ge.created_at::date = current_date - 1
        order by ge.created_at desc
    loop
        raise notice 'yesterday exception id=% user=% distance=%m created=%', v_row.id, v_row.email, v_row.distance_meters, v_row.created_at;
    end loop;
end;
$diagnose$;

commit;
