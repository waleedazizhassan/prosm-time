-- Audit 2026-10-12, item 5.1 - these functions were executable by anon
-- (Supabase's default grant on new functions). Each already rejects a
-- caller with no session, but nothing anonymous should reach them: only
-- signed-in users (and the service role, for Edge Functions) may call
-- them. Every overload is covered, with its exact signature read from
-- the catalog. supabase/tests/anonGrants.test.ts fails when any other
-- public function becomes executable by anon.

begin;

do $$
declare
    v_fn regprocedure;
begin
    for v_fn in
        select p.oid::regprocedure
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
              'admin_clock_out_prosm_time_site_worker',
              'create_prosm_time_site',
              'create_prosm_time_site_worker',
              'generate_organization_code',
              'generate_prosm_time_api_key',
              'list_prosm_time_all_leave_requests',
              'list_prosm_time_report_absences',
              'list_prosm_time_report_exports',
              'list_prosm_time_report_late',
              'list_prosm_time_report_leave_conflicts',
              'list_prosm_time_report_location_violations',
              'list_prosm_time_report_manager_overrides',
              'list_prosm_time_report_missing_checkouts',
              'list_prosm_time_report_site_summary',
              'list_prosm_time_report_workforce',
              'list_prosm_time_site_shifts',
              'list_prosm_time_site_workers',
              'list_prosm_time_visible_members',
              'record_prosm_time_report_export',
              'set_worker_pay_rate',
              'update_prosm_time_site'
          )
    loop
        execute format('revoke execute on function %s from public, anon', v_fn);
        execute format('grant execute on function %s to authenticated, service_role', v_fn);
    end loop;
end;
$$;

commit;
