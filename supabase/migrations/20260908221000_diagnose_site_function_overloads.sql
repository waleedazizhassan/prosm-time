-- PROSM Time - diagnostic only (no schema change). Found live: creating
-- a site through the real app UI (SitesPage.tsx never sets
-- presenceMonitoringEnabled, so p_presence_monitoring_enabled is
-- omitted from the request body entirely - JSON.stringify drops
-- undefined keys) fails outright with PGRST203 "Could not choose the
-- best candidate function" - two live overloads of create_prosm_time_
-- site exist simultaneously. 20260907100000's own header comment
-- claims "create or replace is sufficient... no drop needed" - that
-- claim is WRONG (this session's own established, repeatedly-confirmed
-- lesson: appending a parameter changes a function's identity in
-- Postgres, it does not replace the old overload). Lists every current
-- overload of both create_prosm_time_site and update_prosm_time_site
-- so the real fix (a follow-up migration) drops the exact right ones.

do $$
declare
    r record;
begin
    raise notice '--- create_prosm_time_site overloads ---';
    for r in
        select p.oid, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_prosm_time_site'
    loop
        raise notice 'oid=% args=(%)', r.oid, r.args;
    end loop;

    raise notice '--- update_prosm_time_site overloads ---';
    for r in
        select p.oid, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'update_prosm_time_site'
    loop
        raise notice 'oid=% args=(%)', r.oid, r.args;
    end loop;
end $$;
