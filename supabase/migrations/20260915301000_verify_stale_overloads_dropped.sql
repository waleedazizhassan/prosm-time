-- PROSM Time - diagnostic only, confirms 20260915300000 actually
-- removed the stale overloads and left exactly one live signature for
-- each function.
do $verify$
declare
    v_count integer;
begin
    select count(*) into v_count from pg_proc where proname = 'change_prosm_time_site';
    if v_count <> 1 then
        raise exception 'VERIFY FAILED: change_prosm_time_site has % overloads, expected 1', v_count;
    end if;

    select count(*) into v_count from pg_proc where proname = 'generate_prosm_time_api_key';
    if v_count <> 1 then
        raise exception 'VERIFY FAILED: generate_prosm_time_api_key has % overloads, expected 1', v_count;
    end if;

    raise notice 'VERIFIED: both functions now have exactly 1 live overload each';
end;
$verify$;
