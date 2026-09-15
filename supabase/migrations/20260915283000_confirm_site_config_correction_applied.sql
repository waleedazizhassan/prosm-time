-- PROSM Time - diagnostic only, confirms 20260915281000's data
-- correction actually landed on all 3 real sites.
do $confirm$
declare
    v_row record;
    v_still_wrong integer;
begin
    for v_row in select name, gps_accuracy_tolerance_meters, presence_monitoring_enabled from sites order by name loop
        raise notice 'SITE % : tolerance=% presence_monitoring=%', v_row.name, v_row.gps_accuracy_tolerance_meters, v_row.presence_monitoring_enabled;
    end loop;

    select count(*) into v_still_wrong from sites where gps_accuracy_tolerance_meters = 100 or presence_monitoring_enabled = false;
    raise notice 'SITES STILL NEEDING CORRECTION: %', v_still_wrong;
end;
$confirm$;
