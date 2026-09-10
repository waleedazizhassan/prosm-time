-- PROSM Time - real gap found in the 14-point live-audit: zero
-- anti-fraud signal existed beyond the Anti-Crack license/installation
-- gate (which answers "is this org's license active," never "is this
-- specific GPS reading suspicious"). Adds ONE real, honest, bounded
-- signal: a speed-plausibility check against each user's own last
-- known location. Two consecutive real samples implying >150 km/h of
-- travel in too short a time to be a real human/vehicle movement is a
-- genuine, well-evidenced fraud/spoofing indicator (a common mock-GPS
-- pattern: an instantaneous location jump).
--
-- What this deliberately does NOT claim to be, so as not to overstate
-- coverage: no mock-location-provider flag (neither the browser
-- Geolocation API this app actually uses, nor a bare @capacitor/
-- geolocation call, exposes one - that needs native Android code this
-- pass does not add), no root/jailbreak detection, no device
-- fingerprinting. This is genuinely just: "does this sequence of real
-- coordinates make physical sense."
--
-- A failed/erroring check must never block or break the real
-- attendance/presence flow it's wired into - caught internally and
-- logged, never raised, so a bug in this new heuristic can't itself
-- become a new way to fail a real clock-in or presence sample.
begin;

create table public.location_plausibility_flags (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id),
    previous_latitude double precision not null,
    previous_longitude double precision not null,
    previous_at timestamptz not null,
    latitude double precision not null,
    longitude double precision not null,
    occurred_at timestamptz not null,
    distance_meters double precision not null,
    implied_speed_kmh double precision not null,
    related_entity_type text,
    related_entity_id uuid,
    created_at timestamptz not null default now()
);

create index location_plausibility_flags_organization_id_idx on public.location_plausibility_flags(organization_id);
create index location_plausibility_flags_user_id_idx on public.location_plausibility_flags(user_id);

alter table public.location_plausibility_flags enable row level security;
revoke all on public.location_plausibility_flags from anon, authenticated;
grant select on public.location_plausibility_flags to authenticated;

create policy "location plausibility flags visible to subject or attendance.view"
on public.location_plausibility_flags for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review',
    'correction_submitted', 'correction_reviewed', 'break_exceeded', 'sos_alert',
    'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected',
    'shift_assigned', 'site_change_alert', 'missing_clock_out', 'location_plausibility_flag'
));

create or replace function public.check_prosm_time_location_plausibility(
    p_user_id uuid,
    p_organization_id uuid,
    p_site_id uuid,
    p_latitude double precision,
    p_longitude double precision,
    p_occurred_at timestamptz,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_prev_lat double precision;
    v_prev_lng double precision;
    v_prev_at timestamptz;
    v_distance_meters double precision;
    v_seconds double precision;
    v_speed_kmh double precision;
    v_flag_id uuid;
    v_employee_name text;
    v_max_plausible_kmh constant double precision := 150;
    v_min_seconds_to_check constant double precision := 60;
begin
    if p_latitude is null or p_longitude is null then
        return jsonb_build_object('checked', false);
    end if;

    select latitude, longitude, captured_at into v_prev_lat, v_prev_lng, v_prev_at
    from location_samples
    where user_id = p_user_id and captured_at < p_occurred_at
    order by captured_at desc
    limit 1;

    if v_prev_lat is null then
        select latitude, longitude, occurred_at into v_prev_lat, v_prev_lng, v_prev_at
        from attendance_events
        where user_id = p_user_id and latitude is not null and longitude is not null and occurred_at < p_occurred_at
        order by occurred_at desc
        limit 1;
    end if;

    if v_prev_lat is null then
        return jsonb_build_object('checked', false, 'reason', 'NO_PRIOR_SAMPLE');
    end if;

    v_seconds := extract(epoch from (p_occurred_at - v_prev_at));
    if v_seconds < v_min_seconds_to_check then
        -- Too close together in time for GPS jitter alone not to look
        -- like an implausible speed - not evaluated, not a false flag.
        return jsonb_build_object('checked', false, 'reason', 'TOO_SOON_TO_EVALUATE');
    end if;

    v_distance_meters := 6371000 * 2 * asin(sqrt(
        power(sin(radians(p_latitude - v_prev_lat) / 2), 2) +
        cos(radians(v_prev_lat)) * cos(radians(p_latitude)) *
        power(sin(radians(p_longitude - v_prev_lng) / 2), 2)
    ));
    v_speed_kmh := (v_distance_meters / 1000) / (v_seconds / 3600);

    if v_speed_kmh <= v_max_plausible_kmh then
        return jsonb_build_object('checked', true, 'plausible', true, 'impliedSpeedKmh', round(v_speed_kmh::numeric, 1));
    end if;

    insert into location_plausibility_flags (
        organization_id, user_id, site_id, previous_latitude, previous_longitude, previous_at,
        latitude, longitude, occurred_at, distance_meters, implied_speed_kmh, related_entity_type, related_entity_id
    ) values (
        p_organization_id, p_user_id, p_site_id, v_prev_lat, v_prev_lng, v_prev_at,
        p_latitude, p_longitude, p_occurred_at, v_distance_meters, v_speed_kmh, p_related_entity_type, p_related_entity_id
    )
    returning id into v_flag_id;

    select full_name into v_employee_name from users where id = p_user_id;

    perform public.notify_prosm_time_site_managers_or_owner(
        p_organization_id, p_site_id, 'location_plausibility_flag', 'normal', 'Unusual location movement detected',
        coalesce(v_employee_name, 'An employee') || '''s location implies about ' || round(v_speed_kmh::numeric) || ' km/h since their last known position - please review.',
        'location_plausibility_flags', v_flag_id,
        jsonb_build_object('employeeName', v_employee_name, 'impliedSpeedKmh', round(v_speed_kmh::numeric, 1))
    );

    return jsonb_build_object('checked', true, 'plausible', false, 'impliedSpeedKmh', round(v_speed_kmh::numeric, 1), 'flagId', v_flag_id);
exception
    when others then
        raise warning 'CHECK PROSM TIME LOCATION PLAUSIBILITY FAILED: %', sqlerrm;
        return jsonb_build_object('checked', false, 'reason', 'ERROR');
end;
$function$;

revoke all on function public.check_prosm_time_location_plausibility(uuid, uuid, uuid, double precision, double precision, timestamptz, text, uuid) from public, anon, authenticated;

-- ===== Wire into the two real, already-existing GPS-capture points =====

create or replace function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null,
    p_note text default null,
    p_activity text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
    v_manual_label text;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_no_site_radius integer;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    if exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'YOU ARE ON APPROVED LEAVE TODAY';
    end if;

    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'orphan_auto_closed'
    where user_id = v_caller_id
      and status = 'active'
      and (
        attendance_session_id is null
        or not exists (
            select 1 from attendance_sessions
            where attendance_sessions.id = presence_sessions.attendance_session_id
              and attendance_sessions.status = 'clocked_in'
        )
      );

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_site_id and user_id = v_caller_id;

        if v_is_exempt is null then
            if v_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
            v_is_exempt := false;
        end if;

        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then
                raise exception 'CLOCK_IN_BLOCKED_CONTACT_MANAGER';
            end if;
        end if;

        if p_project_id is not null then
            if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
                raise exception 'PROJECT NOT FOUND AT THIS SITE';
            end if;
            if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
                raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
            end if;
        end if;
    else
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    -- § real gap fix, 14-point live-audit - a real anti-fraud signal,
    -- run before the session/event insert below so it always sees
    -- genuinely prior samples only. Never blocks - see this
    -- migration's own header comment on why.
    perform public.check_prosm_time_location_plausibility(
        v_caller_id, v_caller_org, p_site_id, p_latitude, p_longitude, now(), 'attendance_sessions', null
    );

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', now(), v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), '')
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => p_site_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    elsif p_site_id is null and p_latitude is not null and p_longitude is not null then
        select no_site_allowed_radius_meters into v_no_site_radius from organization_settings where organization_id = v_caller_org;
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, null, p_latitude, p_longitude, coalesce(v_no_site_radius, 500), 'active', now())
        returning id into v_presence_session_id;
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false,
        'geofence', v_geofence, 'presenceSessionId', v_presence_session_id
    );
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

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
