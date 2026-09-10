-- Live verification for 20260910180000's 6 new report RPCs. Simulates
-- a real Owner session. Read-only calls only (no fixtures needed) -
-- confirms each RPC actually executes without error against real data
-- and returns a sane shape, not that specific rows exist (this org's
-- real data varies run to run).
do $$
declare
  v_owner_auth_id uuid;
  v_row_count integer;
begin
  select auth_user_id into v_owner_auth_id from users where email = 'admin@prosm.net' and is_owner = true limit 1;
  if v_owner_auth_id is null then
    raise exception 'VERIFY ABORTED - no Owner account found';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into v_row_count from list_prosm_time_report_workforce();
  raise notice 'CONFIRMED: list_prosm_time_report_workforce returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_site_summary(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_site_summary returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_late(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_late returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_missing_checkouts(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_missing_checkouts returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_leave_conflicts(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_leave_conflicts returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_manager_overrides(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_manager_overrides returned % row(s).', v_row_count;

  select count(*) into v_row_count from list_prosm_time_report_location_violations(current_date - 30, current_date);
  raise notice 'CONFIRMED: list_prosm_time_report_location_violations returned % row(s).', v_row_count;

  raise notice 'VERIFY PASSED - all 7 report RPCs executed cleanly under a real simulated Owner session.';

  -- Restore the real session role - left as 'authenticated' this DO
  -- block would otherwise deny the CLI's own post-migration bookkeeping
  -- insert into supabase_migrations.schema_migrations (a real failure
  -- hit while writing this file).
  perform set_config('role', 'postgres', true);
end $$;
