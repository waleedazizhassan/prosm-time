-- 2026-11-09 (owner): "Ahmed Aziz is clocked in at the head office while he is in Alexandria, and the
-- dashboard does not say he is outside." His clock-in was recorded outside the area (188 km, an
-- exception was opened), but "outside" on the dashboard only followed the live tracking, and his
-- device had sent no location since clocking in. Now a person is shown outside when the live
-- tracking says so, or when the clock-in was outside the area and no location has come since.
-- Rollback: restore the "outside" expression in get_prosm_time_manager_dashboard's open_now CTE.

begin;

do $patch$
declare
    v_oid oid;
    v_def text;
    v_anchor text := 'exists (select 1 from presence_sessions p where p.attendance_session_id = s.id and p.status = ''active'' and p.outside_since is not null) as outside';
begin
    select p.oid into v_oid from pg_proc p where p.proname = 'get_prosm_time_manager_dashboard' and p.pronamespace = 'public'::regnamespace;
    v_def := pg_get_functiondef(v_oid);
    if position(v_anchor in v_def) = 0 then raise exception 'dashboard outside anchor not found'; end if;
    v_def := replace(v_def, v_anchor, '(exists (select 1 from presence_sessions p where p.attendance_session_id = s.id and p.status = ''active'' and p.outside_since is not null)
                or (exists (select 1 from attendance_events e where e.session_id = s.id and e.event_type = ''clock_in'' and e.within_geofence = false)
                    and not exists (select 1 from location_samples ls join presence_sessions p2 on p2.id = ls.presence_session_id where p2.attendance_session_id = s.id))) as outside');
    execute v_def;
end;
$patch$;

commit;
