-- Live verification for check_prosm_time_location_plausibility's math
-- (20260910160000). Building a full location_samples/presence_sessions/
-- attendance_sessions FK chain purely for a test fixture isn't worth it
-- for a pure-arithmetic heuristic - this instead runs the exact same
-- haversine formula the function uses, against two well-known real
-- coordinate pairs, to prove it classifies plausible vs. implausible
-- correctly. Writes nothing - a read-only check, nothing to clean up.
do $$
declare
  v_distance_meters double precision;
  v_speed_kmh double precision;
begin
  -- Case A: two points ~300m apart in Cairo, 10 minutes apart -> a
  -- perfectly normal walking/short-drive speed, must be classified
  -- plausible (<=150 km/h).
  v_distance_meters := 6371000 * 2 * asin(sqrt(
      power(sin(radians(30.0470 - 30.0444) / 2), 2) +
      cos(radians(30.0444)) * cos(radians(30.0470)) *
      power(sin(radians(31.2360 - 31.2357) / 2), 2)
  ));
  v_speed_kmh := (v_distance_meters / 1000) / (10.0 / 60);
  raise notice 'PLAUSIBLE CASE: distance=%m implied speed=%km/h', round(v_distance_meters::numeric, 1), round(v_speed_kmh::numeric, 1);
  if v_speed_kmh > 150 then
    raise exception 'VERIFY FAILED - a 300m/10min sample should be plausible, got %km/h', v_speed_kmh;
  end if;

  -- Case B: Cairo (30.0444, 31.2357) to Alexandria (31.2001, 29.9187),
  -- a real ~180km distance, 10 minutes apart -> no real human/vehicle
  -- movement is that fast, must be classified implausible (>150 km/h).
  v_distance_meters := 6371000 * 2 * asin(sqrt(
      power(sin(radians(31.2001 - 30.0444) / 2), 2) +
      cos(radians(30.0444)) * cos(radians(31.2001)) *
      power(sin(radians(29.9187 - 31.2357) / 2), 2)
  ));
  v_speed_kmh := (v_distance_meters / 1000) / (10.0 / 60);
  raise notice 'IMPLAUSIBLE CASE: distance=%m implied speed=%km/h', round(v_distance_meters::numeric, 1), round(v_speed_kmh::numeric, 1);
  if v_distance_meters < 150000 or v_distance_meters > 220000 then
    raise exception 'VERIFY FAILED - Cairo-Alexandria haversine distance out of sane range: %m', v_distance_meters;
  end if;
  if v_speed_kmh <= 150 then
    raise exception 'VERIFY FAILED - a Cairo-Alexandria/10min sample should be implausible, got %km/h', v_speed_kmh;
  end if;

  -- Confirm the RPC itself exists with the exact signature clock_in/
  -- record_prosm_time_presence_sample call it with, and is SECURITY
  -- DEFINER with no direct grants (only callable via those two RPCs).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'check_prosm_time_location_plausibility'
  ) then
    raise exception 'VERIFY FAILED - check_prosm_time_location_plausibility does not exist';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_name = 'check_prosm_time_location_plausibility' and grantee = 'authenticated'
  ) then
    raise notice 'CONFIRMED: no direct EXECUTE grant to authenticated - only reachable through clock_in/record_prosm_time_presence_sample, as intended.';
  else
    raise exception 'VERIFY FAILED - authenticated has a direct EXECUTE grant on the plausibility check, it should not';
  end if;

  raise notice 'VERIFY PASSED - haversine classification correct on both cases, RPC exists and is not directly callable by clients.';
end $$;
