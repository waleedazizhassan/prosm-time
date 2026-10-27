-- v2.3.55 (owner 2026-10-27, from the phone): an employee clocked in at one
-- site and changed to another mid-shift; the dashboard kept showing them
-- "outside the area" while they stood inside the new site. The presence
-- tracking that decides "inside / outside" was created at clock-in for the
-- first site and never moved. change_prosm_time_site now ends it and starts
-- moves it to the new site (or, changing to no site, to the location given).
-- The function is otherwise the live definition (dumped from the database,
-- since earlier migrations patched it in place).

begin;

alter table public.presence_sessions drop constraint if exists presence_sessions_end_reason_check;
alter table public.presence_sessions add constraint presence_sessions_end_reason_check
    check (end_reason = any (array['clock_out', 'manual_termination', 'orphan_auto_closed', 'auto_closed', 'auto_checkout_geofence', 'site_changed']));

create or replace function public.change_prosm_time_site(p_break_id uuid DEFAULT NULL::uuid, p_new_site_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_manual_location_label text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false)
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
        if v_is_exempt is null then
            if v_new_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_new_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
        end if;
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

commit;
