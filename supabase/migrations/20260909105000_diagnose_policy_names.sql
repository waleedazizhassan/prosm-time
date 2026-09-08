-- Read-only diagnostic: confirm exact live policy names (Postgres
-- silently truncates identifiers over 63 chars, including policy
-- names) before writing DROP POLICY statements against them.
do $diag$
declare
    v_row record;
begin
    for v_row in
        select tablename, policyname from pg_policies
        where tablename in ('sites','attendance_sessions','attendance_events','camera_evidence','correction_requests','geofence_exceptions','presence_sessions')
        and cmd = 'SELECT'
        order by tablename
    loop
        raise notice '% -> %', v_row.tablename, v_row.policyname;
    end loop;
end;
$diag$;
