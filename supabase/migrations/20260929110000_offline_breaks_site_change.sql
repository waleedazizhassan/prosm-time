-- Offline attendance (owner 2026-09-29): a break started/ended or a site changed without a
-- connection is sent later with the time it really happened and a unique operation id, exactly
-- like clock in/out already are (same 5-minute-ahead / 24-hour-back bounds, never before the
-- clock in or the break start). A resend never records twice. New parameters are optional, so
-- every existing call behaves as before; attendance rules (assignment, geofence, break limits,
-- notifications) are unchanged.

alter table public.break_events add column if not exists end_idempotency_key text;
create unique index if not exists break_events_user_id_end_idempotency_key_key on public.break_events (user_id, end_idempotency_key);
alter table public.site_change_events add column if not exists idempotency_key text;
create unique index if not exists site_change_events_user_id_idempotency_key_key on public.site_change_events (user_id, idempotency_key);

drop function if exists public.start_prosm_time_break(uuid, text);
CREATE OR REPLACE FUNCTION public.start_prosm_time_break(p_attendance_session_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_break_id uuid;
    v_existing break_events%rowtype;
    v_effective_time timestamptz;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is not null then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO START A BREAK'; end if;

    if exists (select 1 from break_events where attendance_session_id = p_attendance_session_id and status = 'active') then
        raise exception 'A BREAK IS ALREADY ACTIVE FOR THIS SESSION';
    end if;

    -- Offline capture: the time the break really started (never before the clock in).
    v_effective_time := case
        when p_client_reported_at is not null
            and p_client_reported_at <= now() + interval '5 minutes'
            and p_client_reported_at >= now() - interval '24 hours'
            and p_client_reported_at >= v_session.clock_in_at
        then p_client_reported_at
        else now()
    end;

    if v_session.site_id is not null then
        select * into v_site from sites where id = v_session.site_id;
    end if;

    insert into break_events (organization_id, attendance_session_id, user_id, paid, idempotency_key, started_at)
    values (v_session.organization_id, p_attendance_session_id, v_caller_id, coalesce(v_site.break_paid_by_default, true), p_idempotency_key, v_effective_time)
    returning id into v_break_id;

    return jsonb_build_object('success', true, 'breakId', v_break_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
    when others then
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

drop function if exists public.end_prosm_time_break(uuid);
CREATE OR REPLACE FUNCTION public.end_prosm_time_break(p_break_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
    v_effective_time timestamptz;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    -- A resend of an end that already reached the server (offline sync): the same answer, never a second end.
    if p_idempotency_key is not null and v_break.end_idempotency_key = p_idempotency_key then
        return jsonb_build_object('success', true, 'maxDurationExceeded', v_break.max_duration_exceeded, 'replay', true);
    end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    -- Offline capture: the time the break really ended (never before it started).
    v_effective_time := case
        when p_client_reported_at is not null
            and p_client_reported_at <= now() + interval '5 minutes'
            and p_client_reported_at >= now() - interval '24 hours'
            and p_client_reported_at >= v_break.started_at
        then p_client_reported_at
        else now()
    end;

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    -- No site (or no site policy) to check the max duration against -
    -- never flagged as exceeded, same as it simply never being
    -- configured on a real site.
    v_exceeded := coalesce(extract(epoch from (v_effective_time - v_break.started_at)) / 60 > v_site.break_max_duration_minutes, false);

    update break_events set status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded, end_idempotency_key = p_idempotency_key where id = p_break_id;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_break.organization_id, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'END PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

drop function if exists public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text);
CREATE OR REPLACE FUNCTION public.change_prosm_time_site(p_break_id uuid DEFAULT NULL::uuid, p_new_site_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_manual_location_label text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
    -- Offline capture: the time of the move (never before the clock in).
    v_effective_time := case
        when p_client_reported_at is not null
            and p_client_reported_at <= now() + interval '5 minutes'
            and p_client_reported_at >= now() - interval '24 hours'
            and p_client_reported_at >= v_session.clock_in_at
        then p_client_reported_at
        else now()
    end;

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
        update break_events set status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded where id = p_break_id;
    end if;

    update attendance_sessions
    set site_id = p_new_site_id, project_id = null, manual_location_label = case when p_new_site_id is null then v_manual_label else null end
    where id = v_session.id;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters, manual_location_label, changed_at, idempotency_key)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters, v_manual_label, v_effective_time, p_idempotency_key)
    returning id into v_change_id;

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

revoke execute on function public.start_prosm_time_break(uuid, text, timestamptz) from public, anon;
revoke execute on function public.end_prosm_time_break(uuid, text, timestamptz) from public, anon;
revoke execute on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text, text, timestamptz) from public, anon;
grant execute on function public.start_prosm_time_break(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.end_prosm_time_break(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision, text, text, timestamptz) to authenticated, service_role;
