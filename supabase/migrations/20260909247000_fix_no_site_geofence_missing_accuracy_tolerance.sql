-- PROSM Time - real bug found investigating item 1 of a user report
-- ("clocked in today, stayed put, got a false out-of-zone message" -
-- real account waleedaziz144@yahoo.com, two exceptions today at
-- distance=871m and distance=15001m, both on a no-site/walk-in
-- presence session).
--
-- compute_prosm_time_geofence_check (the WITH-a-registered-site path,
-- 20260831200000) correctly widens its effective radius by BOTH the
-- site's own configured gps_accuracy_tolerance_meters AND the specific
-- sample's own reported accuracy_meters - "a noisier reading earns
-- more tolerance, not less" per that migration's own header comment.
--
-- record_prosm_time_presence_sample's NO-SITE branch (added
-- 20260904110000, unchanged since) never got the same treatment - it
-- compares the raw haversine distance straight against
-- presence_sessions.radius_meters with NO accuracy buffer at all,
-- even though p_accuracy_meters is already being received and stored
-- in location_samples right above it. Any walk-in/no-site clocked-in
-- user whose phone reports a real GPS accuracy_meters figure (which on
-- a real device is very often 50-500m indoors or in dense areas, and
-- occasionally far worse on a cold GPS fix) can trip a false exception
-- for movement that never actually happened - exactly the class of bug
-- 20260831200000's own site-based path was built specifically to
-- avoid, just never carried over to this later-added branch.
--
-- Fix: add the same coalesce(p_accuracy_meters, 0) buffer here too.
-- Does not fully explain the 15001m sample by itself (a genuine 15km
-- reading is far beyond anything a GPS accuracy tolerance should ever
-- absorb - that one real sample was almost certainly a real bad
-- network-based location fix on the device itself, a client-side
-- concern, not something to paper over server-side) - documented
-- honestly rather than silently "fixed" by widening tolerance to an
-- unreasonable degree.

begin;

create or replace function public.record_prosm_time_presence_sample(
    p_presence_session_id uuid,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_session presence_sessions%rowtype;
    v_sample_id uuid;
    v_geofence jsonb;
    v_exception_created boolean := false;
    v_distance_meters double precision;
    v_effective_radius_meters double precision;
    v_violation_result jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_latitude is null or p_longitude is null then
        raise exception 'LATITUDE AND LONGITUDE ARE REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS NOT ACTIVE';
    end if;

    insert into location_samples (presence_session_id, user_id, latitude, longitude, accuracy_meters, client_reported_at)
    values (p_presence_session_id, v_caller_id, p_latitude, p_longitude, p_accuracy_meters, p_client_reported_at)
    returning id into v_sample_id;

    if v_session.site_id is not null then
        v_geofence := public.compute_prosm_time_geofence_check(v_session.site_id, p_latitude, p_longitude, p_accuracy_meters);
    else
        v_distance_meters := 6371000 * 2 * asin(sqrt(
            power(sin(radians(p_latitude - v_session.anchor_latitude) / 2), 2) +
            cos(radians(v_session.anchor_latitude)) * cos(radians(p_latitude)) *
            power(sin(radians(p_longitude - v_session.anchor_longitude) / 2), 2)
        ));
        -- The real fix: widen the allowed radius by the sample's own
        -- reported GPS accuracy, exactly like the with-site path
        -- already does - a noisier reading earns more tolerance here
        -- too, not a false violation.
        v_effective_radius_meters := v_session.radius_meters + coalesce(p_accuracy_meters, 0);
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_effective_radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters,
            'effectiveRadiusMeters', v_effective_radius_meters
        );
    end if;

    if coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = false then
        if not exists (
            select 1 from geofence_exceptions
            where presence_session_id = p_presence_session_id
            and status in ('pending_reason', 'pending_review')
        ) then
            v_violation_result := public.handle_prosm_time_geofence_violation(
                v_session.organization_id, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
                p_presence_session_id => p_presence_session_id, p_site_id => v_session.site_id
            );
            v_exception_created := coalesce((v_violation_result->>'exceptionCreated')::boolean, false);
        end if;
    end if;

    return jsonb_build_object(
        'success', true, 'sampleId', v_sample_id,
        'geofence', v_geofence, 'exceptionCreated', v_exception_created
    );
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

commit;
