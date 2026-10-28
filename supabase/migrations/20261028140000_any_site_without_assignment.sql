-- v2.3.59 (owner 2026-10-28: "why must I be assigned to a site to clock in
-- there or change my site to it?"): a person may clock in at, or change their
-- site to, any active site of their organisation, assigned or not. Before,
-- someone not assigned was let in only from inside the site's work area - and
-- a laptop or a weak GPS fix never is. Nothing else changes: the site's work
-- area is still checked and recorded, leaving it still alerts the managers,
-- a site that blocks clock-in outside its area or after the grace time still
-- blocks (only an assignment marked exempt passes those, as before), and a
-- project still needs its own assignment. Both bodies are the live ones with
-- only that check replaced.

begin;

CREATE OR REPLACE FUNCTION public.clock_in_prosm_time_attendance(p_idempotency_key text, p_site_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_manual_location_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_activity text DEFAULT NULL::text, p_offline_replay boolean DEFAULT false, p_is_mock_location boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
    v_can_override boolean := false;
    v_overrides text[] := array[]::text[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    -- Owner 2026-10-18: attendance is recorded for the people below the
    -- Owner only - the Owner does not clock in or out.
    if public.current_prosm_time_user_is_owner() then
        raise exception 'THE OWNER DOES NOT CLOCK IN OR OUT';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, null, p_site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

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

        -- Owner 2026-10-28: any site of the organisation, assigned or not; the
        -- site's own rules (work area, blocks) apply as to anyone not exempt.
        v_is_exempt := coalesce(v_is_exempt, false);

        -- Step 1 (item 10): a holder of attendance.override_block at this
        -- site passes the self-service blocks; the override is audited below.
        v_can_override := public.prosm_time_caller_can_override_block(p_site_id);

        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then
                if not v_can_override then
                    raise exception 'CLOCK_IN_BLOCKED_CONTACT_MANAGER';
                end if;
                v_overrides := array_append(v_overrides, 'after_grace');
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

    -- Audit 2.4 - a location the device reports as simulated (Android mock
    -- location): refused when the organisation says so, otherwise kept
    -- and sent to the managers for review.
    if p_is_mock_location and exists (select 1 from organization_settings where organization_id = v_caller_org and reject_mock_location) then
        raise exception 'A FAKE LOCATION IS NOT ACCEPTED';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    -- Audit 2.1 (owner decision 2026-10-13, option a) - the site may refuse
    -- a self clock-in from outside its work area (exempt employees still
    -- may), like the clock-out setting; a manager can clock them in.
    if v_site.id is not null
        and v_site.outside_zone_policy = 'BLOCK'
        and not coalesce(v_is_exempt, false)
        and coalesce((v_geofence->>'checked')::boolean, false)
        and (v_geofence->>'withinGeofence')::boolean = false
    then
        if not v_can_override then
            raise exception 'CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER';
        end if;
        v_overrides := array_append(v_overrides, 'outside_zone');
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', v_effective_time, v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity, time_source, is_mock_location
    ) values (
        v_session_id, v_caller_id, 'clock_in', v_effective_time, p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), ''), v_time_source, p_is_mock_location
    )
    returning id into v_event_id;

    if p_is_mock_location then
        perform public.record_prosm_time_mock_location(v_caller_org, v_caller_id, p_site_id, v_event_id, 'clock_in', p_latitude, p_longitude, v_effective_time);
    end if;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, p_site_id, 'clock_in', 'attendance_events', v_event_id, v_effective_time);
    end if;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => p_site_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', v_effective_time)
        returning id into v_presence_session_id;
    elsif p_site_id is null and p_latitude is not null and p_longitude is not null then
        select no_site_allowed_radius_meters into v_no_site_radius from organization_settings where organization_id = v_caller_org;
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, null, p_latitude, p_longitude, coalesce(v_no_site_radius, 500), 'active', v_effective_time)
        returning id into v_presence_session_id;
    end if;

    if cardinality(v_overrides) > 0 then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, new_state, context)
        values (
            v_caller_org, v_caller_id, v_caller_id, 'attendance.override_block', 'attendance_sessions', v_session_id,
            'Clock-in past a site block with manager authority', array_to_string(v_overrides, ','),
            jsonb_build_object('status', 'clocked_in', 'clockInAt', v_effective_time),
            jsonb_build_object('siteId', p_site_id, 'blocks', to_jsonb(v_overrides), 'distanceMeters', v_geofence->'distanceMeters',
                               'latitude', p_latitude, 'longitude', p_longitude, 'accuracyMeters', p_accuracy_meters)
        );
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false, 'overrides', to_jsonb(v_overrides),
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

CREATE OR REPLACE FUNCTION public.change_prosm_time_site(p_break_id uuid DEFAULT NULL::uuid, p_new_site_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_manual_location_label text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_break break_events%rowtype;
    v_session attendance_sessions%rowtype;
    v_old_site sites%rowtype;
    v_new_site sites%rowtype;
    v_old_site_id uuid;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_exceeded boolean := false;
    v_change_id uuid;
    v_manual_label text;
    v_employee_name text;
    v_change_body text;
    v_existing_change site_change_events%rowtype;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

    -- A resend of a site change that already reached the server (offline sync): the same answer.
    if p_idempotency_key is not null then
        select * into v_existing_change from site_change_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_change.id is not null then
            return jsonb_build_object('success', true, 'siteChangeId', v_existing_change.id, 'newSiteId', v_existing_change.new_site_id, 'maxDurationExceeded', false, 'replay', true);
        end if;
    end if;

    if p_break_id is not null then
        select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
        if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
        if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

        select * into v_session from attendance_sessions where id = v_break.attendance_session_id and user_id = v_caller_id;
    else
        select * into v_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    end if;

    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO CHANGE SITE'; end if;

    v_old_site_id := v_session.site_id;
    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_session.clock_in_at, v_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if p_new_site_id is null then
        if v_old_site_id is null then
            raise exception 'YOU ARE ALREADY WORKING WITHOUT A REGISTERED SITE';
        end if;
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
        if p_latitude is null or p_longitude is null then
            raise exception 'A REAL LOCATION SAMPLE IS REQUIRED TO CHANGE TO NO SITE';
        end if;
    else
        select * into v_new_site from sites where id = p_new_site_id and organization_id = v_caller_org and is_active = true;
        if v_new_site.id is null then raise exception 'SITE NOT FOUND'; end if;

        if v_old_site_id = p_new_site_id then
            raise exception 'YOU ARE ALREADY AT THIS SITE';
        end if;

        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_new_site_id and user_id = v_caller_id;
        -- Owner 2026-10-28: any site of the organisation, assigned or not.
        v_is_exempt := coalesce(v_is_exempt, false);
    end if;

    if v_old_site_id is not null then
        select * into v_old_site from sites where id = v_old_site_id;
    end if;

    if p_break_id is not null then
        v_exceeded := coalesce(extract(epoch from (v_effective_time - v_break.started_at)) / 60 > v_old_site.break_max_duration_minutes, false);
        update break_events set status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded, end_time_source = v_time_source where id = p_break_id;
    end if;

    update attendance_sessions
    set site_id = p_new_site_id, project_id = null, manual_location_label = case when p_new_site_id is null then v_manual_label else null end
    where id = v_session.id;

    -- v2.3.55 (owner 2026-10-27: "after a site change I showed 'outside the
    -- area' although I was inside the new site"): the shift's presence
    -- tracking (one per shift) stayed anchored to the old site. It now moves
    -- to the new site - or, without a site, to the location given - with a
    -- fresh inside/outside state; it stops when the new site is not monitored.
    if p_new_site_id is not null and v_new_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session.id, v_caller_id, p_new_site_id, 'active', v_effective_time)
        on conflict (attendance_session_id) do update
        set site_id = excluded.site_id, anchor_latitude = null, anchor_longitude = null, radius_meters = null,
            status = 'active', ended_at = null, end_reason = null,
            outside_since = null, last_inside_at = null, exit_since = null, exit_good_samples = 0, exit_prompted_at = null, exit_dismissed_at = null;
    elsif p_new_site_id is null and p_latitude is not null and p_longitude is not null then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session.id, v_caller_id, null, p_latitude, p_longitude,
                coalesce((select no_site_allowed_radius_meters from organization_settings where organization_id = v_caller_org), 500), 'active', v_effective_time)
        on conflict (attendance_session_id) do update
        set site_id = null, anchor_latitude = excluded.anchor_latitude, anchor_longitude = excluded.anchor_longitude, radius_meters = excluded.radius_meters,
            status = 'active', ended_at = null, end_reason = null,
            outside_since = null, last_inside_at = null, exit_since = null, exit_good_samples = 0, exit_prompted_at = null, exit_dismissed_at = null;
    else
        update presence_sessions set status = 'ended', ended_at = v_effective_time, end_reason = 'site_changed'
        where attendance_session_id = v_session.id and status = 'active';
    end if;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters, manual_location_label, changed_at, idempotency_key, time_source)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters, v_manual_label, v_effective_time, p_idempotency_key, v_time_source)
    returning id into v_change_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, coalesce(p_new_site_id, v_old_site_id), 'site_change', 'site_change_events', v_change_id, v_effective_time);
    end if;

    -- § real gap fix, 14-point live-audit - a real alert on every
    -- mid-shift site change, scoped to whichever real site(s) are
    -- actually involved (+ the Owner, always).
    select full_name into v_employee_name from users where id = v_caller_id;
    v_change_body := v_employee_name || ' changed site mid-shift, from '
        || coalesce(v_old_site.name, 'an unregistered location') || ' to '
        || coalesce(v_new_site.name, v_manual_label, 'an unregistered location') || '.';

    if v_old_site_id is not null then
        perform public.notify_prosm_time_site_managers_or_owner(
            v_caller_org, v_old_site_id, 'site_change_alert', 'normal', 'Employee changed site mid-shift',
            v_change_body, 'site_change_events', v_change_id,
            jsonb_build_object('employeeName', v_employee_name, 'oldSiteName', v_old_site.name, 'newSiteName', coalesce(v_new_site.name, v_manual_label))
        );
    end if;
    if p_new_site_id is not null then
        perform public.notify_prosm_time_site_managers_or_owner(
            v_caller_org, p_new_site_id, 'site_change_alert', 'normal', 'Employee changed site mid-shift',
            v_change_body, 'site_change_events', v_change_id,
            jsonb_build_object('employeeName', v_employee_name, 'oldSiteName', v_old_site.name, 'newSiteName', coalesce(v_new_site.name, v_manual_label))
        );
    end if;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'siteChangeId', v_change_id, 'newSiteId', p_new_site_id, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'CHANGE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

-- The clock-in picker: every active site of the organisation (a member sees
-- only their assigned sites through the table itself), theirs first.
create or replace function public.list_prosm_time_clock_in_sites()
returns setof public.sites
language sql
stable
security definer
set search_path = public
as $function$
    select s.*
    from sites s
    where s.organization_id = public.current_prosm_time_organization_id()
      and s.is_active
      and public.current_prosm_time_user_id() is not null
    order by exists (select 1 from site_assignments sa where sa.site_id = s.id and sa.user_id = public.current_prosm_time_user_id()) desc, s.name;
$function$;

revoke all on function public.list_prosm_time_clock_in_sites() from public, anon;
grant execute on function public.list_prosm_time_clock_in_sites() to authenticated;

commit;
