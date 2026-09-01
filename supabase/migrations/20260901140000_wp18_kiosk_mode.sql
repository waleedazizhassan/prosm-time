-- PROSM Time Implementation Master File V3.0, WP-18 (Kiosk Mode |
-- §13.1). "Shared-device UI, per-employee identification, fixed-site
-- GPS handling." `sites.kiosk_mode` ('personal_device_only' |
-- 'kiosk_only' | 'both_allowed') already exists (WP-05) - this
-- migration is the real per-employee PIN identification + the kiosk
-- Clock In/Out RPCs that use it.
--
-- Identification model (§13.1 names PIN, badge scan, or account
-- selection - this builds PIN, the one that needs no extra hardware):
-- the kiosk SCREEN runs inside an already-authenticated browser
-- session (whoever set the shared device up stays signed in - there is
-- no separate "device account" concept in this schema, and inventing
-- one is not required by the Master File). That caller's identity is
-- NOT who gets clocked in, though - the security boundary is each
-- employee's own PIN, verified server-side against their own
-- kiosk_pin_hash (pgcrypto, never stored/compared in plaintext),
-- exactly like a badge scan authenticates the badge-holder rather than
-- whoever is standing at the reader. Any authenticated member of the
-- site's own organization may operate the shared screen; the
-- self-identification is what actually authorizes the Clock In/Out.
--
-- Fixed-site GPS (§13.1: "Kiosk device GPS is fixed/known - the
-- site's own coordinates"): the kiosk RPCs never take a client-
-- supplied latitude/longitude at all - they run the exact same
-- compute_prosm_time_geofence_check() (WP-09) using the SITE's own
-- stored coordinates, which trivially always resolves within-geofence
-- (distance ~0) rather than special-casing "always pass".
--
-- Auditability (§13.1: "individual, auditable attendance events per
-- employee - never a shared/anonymous log"): attendance_events gains
-- a `source` column so every kiosk-originated event is explicitly
-- distinguishable in the audit trail from a personal-device
-- self-clock, while still being the SAME real per-employee event row
-- (user_id = the identified employee) - never a separate/anonymous log.
--
-- Presence monitoring (WP-10) is deliberately NOT started for a kiosk
-- clock-in even when the site has presence_monitoring_enabled - that
-- feature is "controlled location sampling" from the employee's own
-- carried device while their shift continues, which does not exist
-- for a kiosk-originated session (the employee walks away from the
-- shared screen). Documented scope decision, not an oversight.

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.attendance_events
    add column source text not null default 'self' check (source in ('self', 'kiosk'));

alter table public.users
    add column kiosk_pin_hash text;

-- ============================================================
-- PIN management
-- ============================================================

create or replace function public.set_prosm_time_kiosk_pin(p_pin text)
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

    if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
        raise exception 'PIN MUST BE 4 TO 6 DIGITS';
    end if;

    update users set kiosk_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where id = v_caller_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME KIOSK PIN FAILED: %', sqlerrm;
end;
$function$;

-- §12/§9: an administrator resetting an employee's kiosk PIN is the
-- same authority tier as editing their profile - reuses the existing
-- employees.manage_accounts permission rather than inventing a new one.
create or replace function public.admin_set_prosm_time_kiosk_pin(
    p_user_id uuid,
    p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target users%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
        raise exception 'PIN MUST BE 4 TO 6 DIGITS';
    end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_target.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'employees.manage_accounts' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO SET THIS EMPLOYEE''S KIOSK PIN';
    end if;

    update users set kiosk_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where id = p_user_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'ADMIN SET PROSM TIME KIOSK PIN FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.set_prosm_time_kiosk_pin(text) to authenticated;
grant execute on function public.admin_set_prosm_time_kiosk_pin(uuid, text) to authenticated;

-- ============================================================
-- Kiosk roster - who can be identified at this shared device.
-- ============================================================

create or replace function public.list_prosm_time_kiosk_roster(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_roster jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;

    if v_site.kiosk_mode not in ('kiosk_only', 'both_allowed') then
        raise exception 'KIOSK MODE IS NOT ENABLED FOR THIS SITE';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('userId', u.id, 'fullName', u.full_name) order by u.full_name), '[]'::jsonb)
    into v_roster
    from site_assignments sa
    join users u on u.id = sa.user_id
    where sa.site_id = p_site_id and u.status = 'active';

    return jsonb_build_object('success', true, 'roster', v_roster);
exception
    when others then
        raise exception 'LIST PROSM TIME KIOSK ROSTER FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.list_prosm_time_kiosk_roster(uuid) to authenticated;

-- ============================================================
-- Kiosk Clock In / Out - same real invariants as the personal-device
-- path (idempotency, geofence, notifications), identity established
-- by PIN instead of the caller's own session, location fixed to the
-- site's own coordinates instead of a client-reported sample.
-- ============================================================

create or replace function public.kiosk_clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_employee_user_id uuid,
    p_pin text,
    p_idempotency_key text,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_employee users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_exception_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_employee from users where id = p_employee_user_id;
    if v_employee.id is null or v_employee.organization_id <> v_caller_org then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if v_site.kiosk_mode not in ('kiosk_only', 'both_allowed') then
        raise exception 'KIOSK MODE IS NOT ENABLED FOR THIS SITE';
    end if;
    if not v_site.attendance_allowed then
        raise exception 'ATTENDANCE IS NOT ALLOWED AT THIS SITE';
    end if;

    if v_employee.kiosk_pin_hash is null then
        raise exception 'THIS EMPLOYEE HAS NOT SET UP A KIOSK PIN';
    end if;
    if extensions.crypt(p_pin, v_employee.kiosk_pin_hash) <> v_employee.kiosk_pin_hash then
        raise exception 'INCORRECT PIN';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = p_employee_user_id) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = p_employee_user_id) then
            raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_employee_user_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'THIS EMPLOYEE IS ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, v_site.latitude, v_site.longitude, 0);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, p_employee_user_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, source
    ) values (
        v_session_id, p_employee_user_id, 'clock_in', now(), p_client_reported_at,
        v_site.latitude, v_site.longitude, 0, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        'kiosk'
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, p_employee_user_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, p_employee_user_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            v_employee.full_name || ' clocked in outside the assigned area (kiosk).',
            'geofence_exceptions', v_exception_id
        );
    end if;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false, 'geofence', v_geofence);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'KIOSK CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'KIOSK CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.kiosk_clock_out_prosm_time_attendance(
    p_site_id uuid,
    p_employee_user_id uuid,
    p_pin text,
    p_idempotency_key text,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_employee users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_event_id uuid;
    v_geofence jsonb;
    v_exception_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_employee from users where id = p_employee_user_id;
    if v_employee.id is null or v_employee.organization_id <> v_caller_org then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if v_site.kiosk_mode not in ('kiosk_only', 'both_allowed') then
        raise exception 'KIOSK MODE IS NOT ENABLED FOR THIS SITE';
    end if;

    if v_employee.kiosk_pin_hash is null then
        raise exception 'THIS EMPLOYEE HAS NOT SET UP A KIOSK PIN';
    end if;
    if extensions.crypt(p_pin, v_employee.kiosk_pin_hash) <> v_employee.kiosk_pin_hash then
        raise exception 'INCORRECT PIN';
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_employee_user_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'THIS EMPLOYEE IS NOT CURRENTLY CLOCKED IN';
    end if;
    if v_open_session.site_id <> p_site_id then
        raise exception 'THIS EMPLOYEE IS CLOCKED IN AT A DIFFERENT SITE';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, v_site.latitude, v_site.longitude, 0);

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, source
    ) values (
        v_open_session.id, p_employee_user_id, 'clock_out', now(), p_client_reported_at,
        v_site.latitude, v_site.longitude, 0, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        'kiosk'
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, p_employee_user_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, p_employee_user_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked out outside their work area',
            v_employee.full_name || ' clocked out outside the assigned area (kiosk).',
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
        select * into v_existing_event from attendance_events where user_id = p_employee_user_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'KIOSK CLOCK OUT FAILED: %', sqlerrm;
    when others then
        raise exception 'KIOSK CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.kiosk_clock_in_prosm_time_attendance(uuid, uuid, text, text, uuid, timestamptz) to authenticated;
grant execute on function public.kiosk_clock_out_prosm_time_attendance(uuid, uuid, text, text, timestamptz) to authenticated;

commit;
