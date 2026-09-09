-- PROSM Time - diagnostic-only (self-cleaning): confirm the deployed
-- submit_prosm_time_correction_request actually passes a non-null
-- site_id through to notify_prosm_time_site_managers_or_owner for a
-- real attendance session that does have one.

begin;

do $diagnose$
declare
    v_session_site_id uuid;
    v_source text;
begin
    select site_id into v_session_site_id from attendance_sessions where id = '62fa37e8-590c-431b-9522-9a6a00ee44d9';
    raise notice 'SESSION SITE_ID: %', v_session_site_id;

    select prosrc into v_source from pg_proc where proname = 'submit_prosm_time_correction_request';
    raise notice 'DEPLOYED FUNCTION CALLS notify_prosm_time_site_managers_or_owner: %', (v_source like '%notify_prosm_time_site_managers_or_owner%');
    raise notice 'DEPLOYED FUNCTION CALLS notify_prosm_time_supervisors: %', (v_source like '%notify_prosm_time_supervisors%');
end;
$diagnose$;

commit;
