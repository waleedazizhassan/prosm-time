-- PROSM Time - diagnostic only, no schema/data changes. Getting the
-- EXACT live signatures of the RPCs this regression sweep is about to
-- call, straight from pg_proc, rather than trusting migration-file
-- greps (which can pick a stale/superseded version). Also the real
-- overload-duplication check requested: any function name touched by
-- a CREATE OR REPLACE in this session's own migrations (2026-09-13
-- through 2026-09-15) that now has more than one live overload.
do $diag$
declare
    v_row record;
    v_fn text;
    v_fn_list text[] := array[
        'clock_in_prosm_time_attendance', 'clock_out_prosm_time_attendance',
        'admin_clock_in_prosm_time_attendance', 'admin_clock_out_prosm_time_attendance',
        'kiosk_clock_in_prosm_time_attendance', 'kiosk_clock_out_prosm_time_attendance',
        'start_prosm_time_break', 'end_prosm_time_break',
        'trigger_prosm_time_sos_alert', 'resolve_prosm_time_sos_alert',
        'generate_prosm_time_api_key', 'authenticate_prosm_time_api_key',
        'current_prosm_time_managed_site_ids', 'list_prosm_time_visible_members',
        'set_prosm_time_kiosk_pin', 'set_prosm_time_device_binding_status',
        'compute_prosm_time_geofence_check', 'handle_prosm_time_geofence_violation'
    ];
begin
    foreach v_fn in array v_fn_list loop
        for v_row in
            select p.oid, pg_get_function_identity_arguments(p.oid) as args
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v_fn
        loop
            raise notice 'FN % (oid %): (%)', v_fn, v_row.oid, v_row.args;
        end loop;
    end loop;

    raise notice '--- overload duplication scan (session-touched functions) ---';
    for v_row in
        select p.proname, count(*) as overload_count
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
        group by p.proname
        having count(*) > 1
        order by p.proname
    loop
        raise notice 'DUPLICATE OVERLOAD: % has % versions live', v_row.proname, v_row.overload_count;
    end loop;
end;
$diag$;
