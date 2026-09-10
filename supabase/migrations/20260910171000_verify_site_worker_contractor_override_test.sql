-- Self-cleaning live verification for 20260910170000 (contractor_name +
-- admin_clock_out_prosm_time_site_worker). Simulates a real Owner
-- session via request.jwt.claim.sub, exactly as this session's other
-- migration-level RLS/RPC verifications do.
do $$
declare
  v_owner_auth_id uuid;
  v_org_id uuid;
  v_site_id uuid;
  v_worker_id uuid;
  v_attendance_id uuid;
  v_result jsonb;
  v_open_after boolean;
  v_contractor_name text;
begin
  select u.auth_user_id, u.organization_id into v_owner_auth_id, v_org_id
  from users u where u.email = 'admin@prosm.net' and u.is_owner = true limit 1;

  if v_owner_auth_id is null then
    raise exception 'VERIFY ABORTED - no Owner account found';
  end if;

  select id into v_site_id from sites where organization_id = v_org_id and is_active = true limit 1;
  if v_site_id is null then
    raise exception 'VERIFY ABORTED - no active site found for this org';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
  perform set_config('role', 'authenticated', true);

  -- Create a real worker with a contractor name via the real RPC.
  v_result := public.create_prosm_time_site_worker(v_site_id, 'Verify Test Worker', '900199', 'Al-Amal Contracting Co.');
  if not coalesce((v_result->>'success')::boolean, false) then
    raise exception 'VERIFY FAILED - create_prosm_time_site_worker did not succeed: %', v_result;
  end if;
  v_worker_id := (v_result->>'workerId')::uuid;

  select contractor_name into v_contractor_name from site_workers where id = v_worker_id;
  if v_contractor_name <> 'Al-Amal Contracting Co.' then
    raise exception 'VERIFY FAILED - contractor_name did not persist, got %', v_contractor_name;
  end if;
  raise notice 'CONFIRMED: contractor_name persisted correctly (%).', v_contractor_name;

  -- Confirm list_prosm_time_site_workers reports no open session yet.
  if exists (select 1 from list_prosm_time_site_workers(v_site_id) where id = v_worker_id and has_open_session) then
    raise exception 'VERIFY FAILED - has_open_session should be false before any clock-in';
  end if;

  -- Directly open a real attendance row (as the DB itself would via
  -- kiosk_worker_clock_in - reusing that RPC needs a real device
  -- session unrelated to this Owner one, so insert its own row shape
  -- here instead). site_worker_attendance correctly has no direct
  -- INSERT grant for `authenticated` (writes only happen through the
  -- kiosk Edge Functions' own SECURITY DEFINER RPCs) - drop back to
  -- the superuser role for this one fixture-only write, then restore
  -- the simulated session for the real RPC calls below.
  perform set_config('role', 'postgres', true);
  insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_latitude, clock_in_longitude)
  values (v_org_id, v_worker_id, v_site_id, 30.0444, 31.2357)
  returning id into v_attendance_id;
  perform set_config('role', 'authenticated', true);

  if not exists (select 1 from list_prosm_time_site_workers(v_site_id) where id = v_worker_id and has_open_session) then
    raise exception 'VERIFY FAILED - has_open_session should be true after an open attendance row exists';
  end if;
  raise notice 'CONFIRMED: has_open_session correctly reflects the open attendance row.';

  -- Now the real admin-override RPC under test.
  v_result := public.admin_clock_out_prosm_time_site_worker(v_worker_id, 'Verify test - worker left without checking out.');
  if not coalesce((v_result->>'success')::boolean, false) then
    raise exception 'VERIFY FAILED - admin_clock_out_prosm_time_site_worker did not succeed: %', v_result;
  end if;

  select (clock_out_at is not null) into v_open_after from site_worker_attendance where id = v_attendance_id;
  if not v_open_after then
    raise exception 'VERIFY FAILED - clock_out_at was not set by the override RPC';
  end if;
  raise notice 'CONFIRMED: override RPC closed the open attendance row.';

  if not exists (
    select 1 from audit_logs
    where action = 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF'
    and entity_id = v_attendance_id
    and reason = 'Verify test - worker left without checking out.'
  ) then
    raise exception 'VERIFY FAILED - no audit_logs row was created for the override';
  end if;
  raise notice 'CONFIRMED: audit_logs row created with the real reason text.';

  -- A second override attempt (nothing open now) must fail cleanly.
  begin
    perform public.admin_clock_out_prosm_time_site_worker(v_worker_id, 'Second attempt should fail.');
    raise exception 'VERIFY FAILED - a second override with nothing open should have raised';
  exception
    when others then
      if sqlerrm not ilike '%NOT CURRENTLY CLOCKED IN%' then
        raise exception 'VERIFY FAILED - wrong error for a no-open-session override: %', sqlerrm;
      end if;
      raise notice 'CONFIRMED: a second override with nothing open correctly fails.';
  end;

  raise notice 'VERIFY PASSED - contractor_name, has_open_session, and admin_clock_out_prosm_time_site_worker all behave correctly.';

  -- Clean up every trace of this test run (back to postgres - none of
  -- these tables grant authenticated direct DELETE either).
  perform set_config('role', 'postgres', true);
  delete from audit_logs where entity_id = v_attendance_id and action = 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF';
  delete from site_worker_attendance where id = v_attendance_id;
  delete from site_workers where id = v_worker_id;

  raise notice 'CLEANUP DONE';
end $$;
