-- PROSM Time - diagnostic only, no schema/data changes. Investigating
-- item 3's real root cause after the user's correction that the
-- "no geofence-exit/clock-out-mismatch notification ever fires" bug
-- was observed across ALL account roles (Employee/Admin/Owner), not
-- just the Owner - meaning the Owner-skip bug already fixed in
-- 20260915230000 cannot be the sole explanation. This checks whether
-- geofence violations were ever even being DETECTED (attendance_events
-- with geofence_checked=true/within_geofence=false) historically for
-- non-Owner callers, and whether any resulting exception/notification
-- rows exist, to tell apart "never detected" from "detected but never
-- notified."
do $diag$
declare
    v_row record;
    v_total_violating_events integer;
    v_total_exceptions integer;
    v_total_notifications integer;
begin
    select count(*) into v_total_violating_events
    from attendance_events
    where geofence_checked = true and within_geofence = false;

    select count(*) into v_total_exceptions from geofence_exceptions;

    select count(*) into v_total_notifications
    from notifications where type = 'out_of_zone_employee';

    raise notice 'TOTALS: violating_events=%, geofence_exceptions=%, out_of_zone_notifications=%',
        v_total_violating_events, v_total_exceptions, v_total_notifications;

    for v_row in
        select ae.id, ae.event_type, ae.user_id, ae.occurred_at, ae.distance_meters,
               u.is_owner, r.name as role_name
        from attendance_events ae
        join users u on u.id = ae.user_id
        left join roles r on r.id = u.role_id
        where ae.geofence_checked = true and ae.within_geofence = false
        order by ae.occurred_at desc
        limit 20
    loop
        raise notice 'VIOLATING EVENT % type=% user=% is_owner=% role=% distance=%m at=%',
            v_row.id, v_row.event_type, v_row.user_id, v_row.is_owner, v_row.role_name, v_row.distance_meters, v_row.occurred_at;
    end loop;
end;
$diag$;
