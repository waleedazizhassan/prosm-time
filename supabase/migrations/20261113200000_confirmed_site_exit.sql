-- Owner 2026-11-13: "presence monitoring is on, every permission is given - and the app tells me I moved out of
-- the site while I never left it (accuracy ±19 m). Rebuild this part instead of patching it."
-- What it did: leaving the work area opened a reason request (a geofence exception) on ONE reading, whatever its
-- accuracy; the exit prompt took two good readings, even seconds apart. A single jump of the phone's GPS was
-- enough. One rule now decides both, on the server, for every reading:
--   1. a weak reading counts for nothing: no accuracy given, or worse than 50 m;
--   2. the safety margin around the site grows with the reading's accuracy: radius + the site's tolerance +
--      the accuracy (capped at 50 m) - a reading counts as outside only when its whole circle is outside;
--   3. leaving is confirmed only by 3 good readings in a row outside, spanning at least 3 minutes; one good
--      reading inside clears it;
--   4. only a confirmed leaving opens the reason request and the "you left the site" prompt.
-- Shifts without a site (around the clock-in point) follow the same rule. Rollback: re-run
-- record_prosm_time_presence_sample and prosm_time_track_site_exit from before this migration
-- (pg_get_functiondef); drop prosm_time_presence_state.

begin;

-- the one rule: what this reading says, kept on the presence session (exit_since / exit_good_samples)
create or replace function public.prosm_time_presence_state(p_presence_session_id uuid, p_geofence jsonb, p_accuracy_meters double precision)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_presence presence_sessions%rowtype;
    v_tolerance double precision;
    v_limit double precision;
begin
    if not coalesce((p_geofence ->> 'checked')::boolean, false) then return 'unchecked'; end if;
    select * into v_presence from presence_sessions where id = p_presence_session_id;
    select gps_accuracy_tolerance_meters into v_tolerance from sites where id = v_presence.site_id;
    v_limit := least(greatest(coalesce(v_tolerance, 50), 10), 50);
    if p_accuracy_meters is null or p_accuracy_meters > greatest(v_limit, 50) then return 'weak'; end if;

    if (p_geofence ->> 'withinGeofence')::boolean then
        update presence_sessions set exit_since = null, exit_good_samples = 0 where id = p_presence_session_id;
        return 'inside';
    end if;

    update presence_sessions
    set exit_since = coalesce(exit_since, now()), exit_good_samples = exit_good_samples + 1
    where id = p_presence_session_id
    returning * into v_presence;
    if v_presence.exit_good_samples >= 3 and now() - v_presence.exit_since >= interval '3 minutes' then
        return 'outside';
    end if;
    return 'leaving';
end;
$$;
revoke all on function public.prosm_time_presence_state(uuid, jsonb, double precision) from public, anon, authenticated;

create or replace function public.record_prosm_time_presence_sample(p_presence_session_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_session presence_sessions%rowtype;
    v_sample_id uuid;
    v_geofence jsonb;
    v_exception_created boolean := false;
    v_distance_meters double precision;
    v_effective_radius_meters double precision;
    v_violation_result jsonb;
    v_exit jsonb;
    v_state text;
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

    -- § real gap fix, 14-point live-audit - run against prior samples
    -- BEFORE inserting this one below, so "previous" never means
    -- itself. Never blocks - see this migration's own header comment.
    perform public.check_prosm_time_location_plausibility(
        v_caller_id, v_session.organization_id, v_session.site_id, p_latitude, p_longitude, now(),
        'presence_sessions', p_presence_session_id
    );

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
        -- the same margin as at a site: the reading's accuracy, capped at 50 m
        v_effective_radius_meters := v_session.radius_meters + least(coalesce(p_accuracy_meters, 0), 50);
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_effective_radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters,
            'effectiveRadiusMeters', v_effective_radius_meters
        );
    end if;

    -- 2026-11-13: one rule decides - weak readings count for nothing, leaving needs 3 good readings over 3 minutes
    v_state := public.prosm_time_presence_state(p_presence_session_id, v_geofence, p_accuracy_meters);
    v_geofence := v_geofence || jsonb_build_object('presenceState', v_state);

    -- Owner 2026-10-18: one reason request per time outside the work area - now only once leaving is confirmed.
    -- Coming back inside (a good reading) ends it; only leaving again asks again.
    if v_state = 'outside' then
        if v_session.outside_since is null then
            if not exists (
                select 1 from geofence_exceptions
                where user_id = v_caller_id
                  and created_at >= coalesce(v_session.last_inside_at, v_session.started_at) - interval '1 minute'
            ) then
                v_violation_result := public.handle_prosm_time_geofence_violation(
                    v_session.organization_id, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
                    p_presence_session_id => p_presence_session_id, p_site_id => v_session.site_id
                );
                v_exception_created := coalesce((v_violation_result->>'exceptionCreated')::boolean, false);
            end if;
            update presence_sessions set outside_since = now() where id = p_presence_session_id;
        end if;
    elsif v_state = 'inside' then
        update presence_sessions set outside_since = null, last_inside_at = now() where id = p_presence_session_id;
    end if;

    -- Step 12 (item 24): leaving the site with the shift still open.
    v_exit := public.prosm_time_track_site_exit(p_presence_session_id, v_geofence, p_accuracy_meters);

    return jsonb_build_object(
        'success', true, 'sampleId', v_sample_id,
        'geofence', v_geofence, 'exceptionCreated', v_exception_created, 'exit', v_exit
    );
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

-- the exit prompt follows the same confirmed state (the counting is done above)
do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_track_site_exit(uuid, jsonb, double precision)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def,
        '    -- a weak reading decides nothing
    v_good := p_accuracy_meters is not null and p_accuracy_meters <= greatest(coalesce(v_site.gps_accuracy_tolerance_meters, 50), 10);
    if not v_good then return jsonb_build_object(''ignored'', ''weak_accuracy''); end if;

    if (p_geofence ->> ''withinGeofence'')::boolean then
        update presence_sessions set exit_since = null, exit_good_samples = 0, exit_prompted_at = null, exit_dismissed_at = null where id = p_presence_session_id;
        return jsonb_build_object(''inside'', true);
    end if;

    update presence_sessions set exit_since = coalesce(exit_since, now()), exit_good_samples = exit_good_samples + 1
    where id = p_presence_session_id
    returning * into v_presence;

    if v_presence.exit_good_samples >= 2 and v_presence.exit_prompted_at is null then',
        '    -- 2026-11-13: decided once, by prosm_time_presence_state (weak readings count for nothing; leaving needs
    -- 3 good readings outside over at least 3 minutes)
    v_good := coalesce(p_geofence ->> ''presenceState'', '''') in (''inside'', ''leaving'', ''outside'');
    if not v_good then return jsonb_build_object(''ignored'', ''weak_accuracy''); end if;

    if p_geofence ->> ''presenceState'' = ''inside'' then
        update presence_sessions set exit_prompted_at = null, exit_dismissed_at = null where id = p_presence_session_id;
        return jsonb_build_object(''inside'', true);
    end if;

    select * into v_presence from presence_sessions where id = p_presence_session_id;
    if p_geofence ->> ''presenceState'' = ''leaving'' then
        return jsonb_build_object(''leaving'', true);
    end if;

    if v_presence.exit_prompted_at is null then');
    if v_new = v_def then raise exception 'prosm_time_track_site_exit: anchor not found'; end if;
    execute v_new;
end $$;

commit;
