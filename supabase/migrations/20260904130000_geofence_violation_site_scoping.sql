-- PROSM Time - live UX review, user-directed clarification/fix: a
-- plain employee's geofence violation was still broadcasting to EVERY
-- admin org-wide (notify_prosm_time_supervisors, unchanged from
-- 20260904120000) - so an employee at one site's violation would also
-- notify an admin who only manages a totally different site. User's
-- own words: if the employee is clocked in at a real site, the
-- notification should reach ONLY that site's own manager(s) (+ the
-- Owner, always); if they're clocked in with no site at all (a manual
-- workplace - nothing for a site manager to be scoped to), it reaches
-- the Owner only.
--
-- notify_prosm_time_supervisors() itself is used by many OTHER
-- notification types (SOS alerts, correction/allowance reviews, kiosk
-- events...) that genuinely are org-wide concerns, not site-specific -
-- left completely untouched. This is a new, narrowly-scoped function
-- used only by handle_prosm_time_geofence_violation's own "plain
-- employee" branch.

begin;

create or replace function public.notify_prosm_time_site_managers_or_owner(
    p_organization_id uuid,
    p_site_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null,
    p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_recipient record;
begin
    if p_site_id is not null then
        for v_recipient in
            select distinct u.id
            from users u
            join site_assignments sa on sa.user_id = u.id
            where u.organization_id = p_organization_id
            and sa.site_id = p_site_id
            and sa.role_at_site = 'manager'
        loop
            perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
        end loop;
    end if;

    -- The Owner always sees this too - both as the no-site fallback
    -- and as the standing escalation on top of that site's own
    -- manager(s). create_prosm_time_notification's own 15-minute
    -- dedup already makes a double-call harmless if the Owner also
    -- happens to be that site's own assigned manager.
    for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke all on function public.notify_prosm_time_site_managers_or_owner(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- ===== handle_prosm_time_geofence_violation - a new p_site_id param,
-- used only for the "plain employee" branch's now site-scoped
-- routing. The Owner-exempt and Admin-escalates-to-owner branches are
-- unchanged. =====

create or replace function public.handle_prosm_time_geofence_violation(
    p_organization_id uuid,
    p_user_id uuid,
    p_distance_meters double precision,
    p_attendance_event_id uuid default null,
    p_presence_session_id uuid default null,
    p_site_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_is_owner boolean;
    v_is_supervisor boolean;
    v_exception_id uuid;
    v_subject_name text;
    v_recipient record;
begin
    select is_owner into v_is_owner from users where id = p_user_id;

    if coalesce(v_is_owner, false) then
        return jsonb_build_object('exceptionCreated', false);
    end if;

    insert into geofence_exceptions (organization_id, user_id, attendance_event_id, presence_session_id, distance_meters, status)
    values (p_organization_id, p_user_id, p_attendance_event_id, p_presence_session_id, p_distance_meters, 'pending_reason')
    returning id into v_exception_id;

    select full_name into v_subject_name from users where id = p_user_id;

    perform public.create_prosm_time_notification(
        p_organization_id, p_user_id, 'out_of_zone_employee', 'normal',
        'You are outside your assigned work area',
        'Please explain why. Distance: ' || round(p_distance_meters::numeric) || ' m.',
        'geofence_exceptions', v_exception_id,
        jsonb_build_object('distanceMeters', round(p_distance_meters::numeric))
    );

    v_is_supervisor := exists (
        select 1 from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join users u on u.role_id = rdp.role_id
            where u.id = p_user_id
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = false
        ) effective
        where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
    );

    if v_is_supervisor then
        for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                p_organization_id, v_recipient.id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
                v_subject_name || ' is outside the assigned area.', 'geofence_exceptions', v_exception_id,
                jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
            );
        end loop;
    else
        -- § live UX review, user-directed - a plain employee's
        -- violation reaches only that specific site's own manager(s)
        -- (+ the Owner, always) - not every admin in the organization
        -- regardless of which site they actually manage.
        perform public.notify_prosm_time_site_managers_or_owner(
            p_organization_id, p_site_id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
            v_subject_name || ' is outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
        );
    end if;

    return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
exception
    when others then
        raise exception 'HANDLE PROSM TIME GEOFENCE VIOLATION FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.handle_prosm_time_geofence_violation(uuid, uuid, double precision, uuid, uuid, uuid) from public, anon, authenticated;

-- ===== Thread p_site_id through the three call sites =====

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text);

create function public.clock_in_prosm_time_attendance(
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

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text) to authenticated;

drop function if exists public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text);

create function public.clock_out_prosm_time_attendance(
    p_idempotency_key text,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
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
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_is_exempt boolean;
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

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(v_open_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    if v_open_session.site_id is not null and (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        select * into v_site from sites where id = v_open_session.site_id;
        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = v_open_session.site_id and user_id = v_caller_id;

        if v_site.block_self_clock_out_outside_geofence and not coalesce(v_is_exempt, false) then
            raise exception 'CLOCK_OUT_BLOCKED_CONTACT_MANAGER';
        end if;
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', now(), p_client_reported_at,
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
            p_attendance_event_id => v_event_id, p_site_id => v_open_session.site_id
        );
    end if;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'replay', false, 'geofence', v_geofence);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text) from public, anon;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text) to authenticated;

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
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_session.radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters
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

grant execute on function public.record_prosm_time_presence_sample(uuid, double precision, double precision, double precision, timestamptz) to authenticated;

commit;
