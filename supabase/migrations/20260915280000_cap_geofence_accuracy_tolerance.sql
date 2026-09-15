-- PROSM Time - real root-cause fix for item 3 (2026-09-15), part 2 of 2.
--
-- The diagnostic in 20260915270000 showed the geofence-violation
-- pipeline had recorded exactly ONE violating event in this system's
-- entire history - a 17.4km clock-out by the Owner (already explained
-- by the now-fixed Owner-skip bug in handle_prosm_time_geofence_violation,
-- 20260915230000). Every other real test the user ran across Employee/
-- Admin/Owner accounts produced NOTHING in attendance_events at all -
-- not even a detected-but-unnotified violation. That means those
-- violations were never being DETECTED in the first place, which is
-- an account-agnostic (site-config-driven) problem, matching the
-- user's own correction ("كانت متواجدة في كل الاكونتات").
--
-- Root cause: compute_prosm_time_geofence_check's effective radius is
-- allowed_radius_meters + gps_accuracy_tolerance_meters +
-- p_accuracy_meters (the phone's own self-reported GPS accuracy for
-- THIS sample, fully client-controlled and unbounded). All 3 real
-- sites have allowed_radius_meters=100 and gps_accuracy_tolerance_meters=100
-- already - an "at rest" 200m effective radius before a single meter
-- of real-world GPS noise is added. A typical outdoor phone reading
-- (20-50m accuracy) pushes this to 220-250m, and a noisier indoor/
-- urban-canyon reading can push it far higher still, since nothing
-- caps p_accuracy_meters's contribution. A real "clocked out at a
-- different location" or "left the site" case has to clear that whole
-- radius before it is ever flagged - which is exactly why nothing
-- showed up for any non-Owner test.
--
-- Fix: cap the per-sample accuracy contribution at a sane ceiling
-- (50m - already generous for a real outdoor GPS fix) so one noisy or
-- client-reported reading cannot silently blow up the effective
-- geofence radius. The site's own configured gps_accuracy_tolerance_meters
-- is left untouched here (that is a real per-site Owner setting, not
-- code) - see the separate data-correction migration
-- (20260915281000) for why the 3 real sites' own value is being
-- brought back down too.
create or replace function public.compute_prosm_time_geofence_check(
    p_site_id uuid,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_site sites%rowtype;
    v_distance_meters double precision;
    v_effective_radius_meters double precision;
    v_capped_accuracy_meters double precision;
begin
    select * into v_site from sites where id = p_site_id;
    if v_site.id is null then
        return jsonb_build_object('checked', false, 'reason', 'SITE_NOT_FOUND');
    end if;

    if not v_site.geofence_required then
        return jsonb_build_object('checked', false, 'reason', 'GEOFENCE_NOT_REQUIRED_FOR_SITE');
    end if;

    if p_latitude is null or p_longitude is null then
        return jsonb_build_object('checked', false, 'reason', 'NO_LOCATION_SAMPLE');
    end if;

    v_distance_meters := 6371000 * 2 * asin(sqrt(
        power(sin(radians(p_latitude - v_site.latitude) / 2), 2) +
        cos(radians(v_site.latitude)) * cos(radians(p_latitude)) *
        power(sin(radians(p_longitude - v_site.longitude) / 2), 2)
    ));

    -- § capped at 50m (2026-09-15) - a single client-reported accuracy
    -- value must never be able to make real geofence violations
    -- undetectable.
    v_capped_accuracy_meters := least(coalesce(p_accuracy_meters, 0), 50);

    v_effective_radius_meters := v_site.allowed_radius_meters + v_site.gps_accuracy_tolerance_meters + v_capped_accuracy_meters;

    return jsonb_build_object(
        'checked', true,
        'withinGeofence', v_distance_meters <= v_effective_radius_meters,
        'distanceMeters', v_distance_meters,
        'allowedRadiusMeters', v_site.allowed_radius_meters,
        'toleranceMeters', v_site.gps_accuracy_tolerance_meters,
        'effectiveRadiusMeters', v_effective_radius_meters
    );
exception
    when others then
        raise exception 'COMPUTE PROSM TIME GEOFENCE CHECK FAILED: %', sqlerrm;
end;
$function$;
