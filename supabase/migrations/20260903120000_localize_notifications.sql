-- PROSM Time - live UX review, user-directed: "notifications need to be
-- translated - they're not translated in Arabic mode." Root cause:
-- every notification's title/body was built as a literal English
-- string at creation time in PL/pgSQL and stored as-is - there was
-- never any localization path for them, regardless of the viewer's
-- own UI language.
--
-- Fix: a new `data jsonb` column carries the STRUCTURED values each
-- notification type actually needs (an employee's name, a distance in
-- meters, which of two sub-cases a shared `type` represents, a
-- manager's decision) instead of baking them into a fixed-language
-- sentence. title/body stay exactly as they are today (still English)
-- - they remain a safe fallback for any client that doesn't recognize
-- a given `type`, and nothing about existing rows/behavior changes.
-- The frontend (NotificationBell.tsx, separate commit) renders from
-- `type` + `data` through i18n when it recognizes the type, falling
-- back to the raw stored title/body otherwise - the same fallback
-- posture humanizeBackendError already established for backend errors.

begin;

alter table public.notifications
    add column data jsonb not null default '{}'::jsonb;

-- ============================================================
-- 1. create_prosm_time_notification / notify_prosm_time_supervisors -
--    one new trailing param each, same "drop the exact old signature"
--    convention already used throughout this codebase.
-- ============================================================

drop function if exists public.create_prosm_time_notification(uuid, uuid, text, text, text, text, text, uuid);

create function public.create_prosm_time_notification(
    p_organization_id uuid,
    p_user_id uuid,
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
begin
    if p_priority <> 'high' and p_related_entity_id is not null and exists (
        select 1 from notifications
        where user_id = p_user_id and type = p_type and related_entity_id = p_related_entity_id
        and created_at > now() - interval '15 minutes'
    ) then
        return;
    end if;

    insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
    values (p_organization_id, p_user_id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, coalesce(p_data, '{}'::jsonb));
end;
$function$;

revoke execute on function public.create_prosm_time_notification(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

drop function if exists public.notify_prosm_time_supervisors(uuid, text, text, text, text, text, uuid);

create function public.notify_prosm_time_supervisors(
    p_organization_id uuid,
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
    v_supervisor record;
begin
    for v_supervisor in
        select u.id from users u
        where u.organization_id = p_organization_id
        and (
            u.is_owner
            or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(u.id), array[]::text[]))
            or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(u.id), array[]::text[]))
        )
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_supervisor.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke execute on function public.notify_prosm_time_supervisors(uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- ============================================================
-- 2. Every real call site (the current/live definition of each - none
--    of these have been redefined since 20260901110000 except
--    clock_in/clock_out, redefined by this same session's own
--    20260903110000). title/body text is unchanged; each call now
--    also passes the structured p_data the frontend needs to render a
--    real localized sentence.
-- ============================================================

create or replace function public.trigger_prosm_time_sos_alert(
    p_presence_session_id uuid,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session presence_sessions%rowtype;
    v_alert_id uuid;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'SOS REQUIRES AN ACTIVE PRESENCE SESSION';
    end if;

    insert into sos_alerts (organization_id, user_id, presence_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, p_presence_session_id, p_latitude, p_longitude, p_accuracy_meters)
    returning id into v_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active presence session.',
        jsonb_build_object('presenceSessionId', p_presence_session_id)
    );

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_caller_org, 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name)
    );

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.submit_prosm_time_exception_reason(
    p_exception_id uuid,
    p_reason_category text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_exception geofence_exceptions%rowtype;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;
    if p_reason_category not in ('purchasing_food', 'restroom', 'work_assignment', 'emergency', 'other') then
        raise exception 'INVALID REASON CATEGORY';
    end if;

    select * into v_exception from geofence_exceptions where id = p_exception_id and user_id = v_caller_id;
    if v_exception.id is null then
        raise exception 'EXCEPTION NOT FOUND';
    end if;
    if v_exception.status <> 'pending_reason' then
        raise exception 'THIS EXCEPTION ALREADY HAS A REASON';
    end if;

    update geofence_exceptions
    set reason_category = p_reason_category, employee_reason = p_reason, reason_submitted_at = now(), status = 'pending_review'
    where id = p_exception_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_exception.organization_id, 'exception_pending_review', 'normal', 'Exception awaiting your review',
        v_caller_name || ' submitted a reason for an out-of-zone exception.',
        'geofence_exceptions', p_exception_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'exception')
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME EXCEPTION REASON FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.submit_prosm_time_correction_request(
    p_attendance_session_id uuid,
    p_proposed_event_type text,
    p_proposed_correct_time timestamptz,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session attendance_sessions%rowtype;
    v_request_id uuid;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_proposed_event_type not in ('clock_in', 'clock_out') then
        raise exception 'INVALID PROPOSED EVENT TYPE';
    end if;
    if p_proposed_correct_time is null then
        raise exception 'PROPOSED CORRECT TIME IS REQUIRED';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;

    insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason)
    values (v_caller_org, v_caller_id, p_attendance_session_id, p_proposed_event_type, p_proposed_correct_time, trim(p_reason))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_caller_org, 'exception_pending_review', 'normal', 'Correction request awaiting your review',
        v_caller_name || ' submitted a correction request.',
        'correction_requests', v_request_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'correction')
    );

    return jsonb_build_object('success', true, 'correctionRequestId', v_request_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME CORRECTION REQUEST FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.review_prosm_time_exception(
    p_kind text,
    p_target_id uuid,
    p_action_type text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EXCEPTIONS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_kind not in ('geofence_exception', 'correction_request') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_cr.user_id, 'correction_reviewed', 'normal', 'Your correction request was reviewed',
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id,
            jsonb_build_object('kind', 'correction', 'actionType', p_action_type)
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.end_prosm_time_break(p_break_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    v_exceeded := extract(epoch from (now() - v_break.started_at)) / 60 > v_site.break_max_duration_minutes;

    update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;

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

-- ============================================================
-- 3. clock_in/clock_out - same signatures as 20260903110000 (this
--    session's own prior migration), only the notification calls
--    inside change - drop+recreate per this codebase's own convention
--    for redefining an already-applied migration's function.
-- ============================================================

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null
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
    v_exception_id uuid;
    v_manual_label text;
    v_is_exempt boolean;
    v_caller_name text;
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
            raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
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
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        select full_name into v_caller_name from users where id = v_caller_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            v_caller_name || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_caller_name, 'distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
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

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) to authenticated;

drop function if exists public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision);

create function public.clock_out_prosm_time_attendance(
    p_idempotency_key text,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
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
    v_exception_id uuid;
    v_site sites%rowtype;
    v_is_exempt boolean;
    v_caller_name text;
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
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        select full_name into v_caller_name from users where id = v_caller_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked out outside their work area',
            v_caller_name || ' clocked out outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_caller_name, 'distanceMeters', round((v_geofence->>'distanceMeters')::numeric))
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

revoke all on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision) from public, anon;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision) to authenticated;

commit;
