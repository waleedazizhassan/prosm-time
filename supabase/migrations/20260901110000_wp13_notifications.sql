-- WP-13 (§20 Notifications). Scope per WP-13's own row: "Clock
-- reminders, exceptions, approvals, escalation, SOS priority
-- delivery." Real in-app notification records + real triggers from
-- already-built RPCs (SOS, geofence exceptions, corrections, break
-- overrun). Time-based "clock reminders" (upcoming/late/missing Clock
-- Out) need a scheduled job - this pass builds the real, checkable
-- query those reminders would run (list_prosm_time_missing_clock_outs)
-- but does not wire up pg_cron scheduling, matching this codebase's
-- own established "foundation vs. full automation" split (WP-08's
-- retention purge). "Timesheet approval pending" has no real trigger
-- yet - WP-16 (Timesheets) doesn't exist; wiring that notification is
-- WP-16's own job once the approval RPC it fires from is built.
-- License/plan lifecycle notifications are deferred (noted, not
-- silently dropped) - out of this pass's realistic scope.

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    type text not null check (type in (
        'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review',
        'correction_submitted', 'correction_reviewed', 'break_exceeded', 'sos_alert'
    )),
    priority text not null default 'normal' check (priority in ('normal', 'high')),
    title text not null,
    body text,
    related_entity_type text,
    related_entity_id uuid,
    read_at timestamptz,
    created_at timestamptz not null default now()
);

create index notifications_user_id_idx on public.notifications(user_id);
create index notifications_user_id_unread_idx on public.notifications(user_id) where read_at is null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

create policy "notifications visible to their own recipient only"
on public.notifications for select to authenticated
using (user_id = public.current_prosm_time_user_id());

-- Internal helper - never granted to authenticated, only called from
-- other SECURITY DEFINER functions. §20: "must avoid excessive
-- repeated alerts... SOS is the sole exception" - a duplicate
-- non-SOS notification of the same type/related entity within 15
-- minutes is silently skipped rather than piling up.
create or replace function public.create_prosm_time_notification(
    p_organization_id uuid,
    p_user_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
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

    insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id)
    values (p_organization_id, p_user_id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
end;
$function$;

revoke execute on function public.create_prosm_time_notification(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;

-- Notifies every org member holding supervisory attendance authority
-- (the same permission set already used for on-behalf/exception
-- review throughout WP-07/10/11 - no separate "manager of this
-- employee" hierarchy exists in this schema).
create or replace function public.notify_prosm_time_supervisors(
    p_organization_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
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
        perform public.create_prosm_time_notification(p_organization_id, v_supervisor.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
    end loop;
end;
$function$;

revoke execute on function public.notify_prosm_time_supervisors(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.mark_prosm_time_notification_read(p_notification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    update notifications set read_at = now() where id = p_notification_id and user_id = v_caller_id and read_at is null;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'MARK PROSM TIME NOTIFICATION READ FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.mark_prosm_time_notification_read(uuid) to authenticated;

-- Foundation for time-based Clock Out reminders (not scheduled this
-- pass - see header comment). Real, checkable, correct today.
create or replace function public.list_prosm_time_missing_clock_outs(p_hours_since_clock_in integer default 12)
returns table (attendance_session_id uuid, user_id uuid, organization_id uuid, clock_in_at timestamptz)
language sql
stable
security definer
set search_path = public
as $function$
    select id, user_id, organization_id, clock_in_at
    from attendance_sessions
    where status = 'clocked_in' and clock_in_at < now() - (p_hours_since_clock_in || ' hours')::interval;
$function$;

revoke execute on function public.list_prosm_time_missing_clock_outs(integer) from public, anon, authenticated;
grant execute on function public.list_prosm_time_missing_clock_outs(integer) to service_role;

-- Re-point trigger_prosm_time_sos_alert (WP-10) to notify every
-- supervisor - "always highest priority, never throttled or grouped."
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
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id
    );

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

-- Re-point clock_in/clock_out (WP-06/09/10/11) to notify the
-- employee + supervisors on a real out-of-zone detection (§20).
create or replace function public.clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_idempotency_key text,
    p_project_id uuid default null,
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
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
    v_exception_id uuid;
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

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
        raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, v_caller_id, p_site_id, p_project_id, 'clocked_in', now())
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

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            (select full_name from users where id = v_caller_id) || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id
        );
    end if;

    if v_site.presence_monitoring_enabled then
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

create or replace function public.clock_out_prosm_time_attendance(
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

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked out outside their work area',
            (select full_name from users where id = v_caller_id) || ' clocked out outside the assigned area.',
            'geofence_exceptions', v_exception_id
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

-- Re-point submit_prosm_time_exception_reason/submit_prosm_time_correction_request
-- (WP-11) to notify supervisors ("pending exception review", §20).
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

    perform public.notify_prosm_time_supervisors(
        v_exception.organization_id, 'exception_pending_review', 'normal', 'Exception awaiting your review',
        (select full_name from users where id = v_caller_id) || ' submitted a reason for an out-of-zone exception.',
        'geofence_exceptions', p_exception_id
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

    perform public.notify_prosm_time_supervisors(
        v_caller_org, 'exception_pending_review', 'normal', 'Correction request awaiting your review',
        (select full_name from users where id = v_caller_id) || ' submitted a correction request.',
        'correction_requests', v_request_id
    );

    return jsonb_build_object('success', true, 'correctionRequestId', v_request_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME CORRECTION REQUEST FAILED: %', sqlerrm;
end;
$function$;

-- Re-point review_prosm_time_exception (WP-11) to notify the employee
-- of the manager's decision ("correction request submitted/reviewed").
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
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id
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
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

-- Re-point end_prosm_time_break (WP-12) to notify on max-duration
-- exceeded (§20, "not a hard block").
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
