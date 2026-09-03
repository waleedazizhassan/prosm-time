-- PROSM Time - live UX review, user-directed (2026-09-03):
--
-- 1. Self clock-out outside a real site's geofence currently only
--    records a geofence_exception (with employee+manager notifications
--    - already wired, unchanged) - it never blocks. Mirrors the
--    existing clock-in-after-grace block exactly: a new opt-in per-
--    site toggle, a new CLOCK_OUT_BLOCKED_CONTACT_MANAGER marker the
--    frontend already recognizes (ClockInOutCard.tsx), resolved via
--    the already-existing, already-reason-required
--    admin_clock_out_prosm_time_attendance (no change needed there).
--
-- 2. Per-site employee exemption from both blocks (clock-in-after-
--    grace and the new clock-out-outside-geofence one) - "a field with
--    employee options so we can exempt specific employees from the
--    time/out-of-zone restrictions." Reuses site_assignments (already
--    links site_id+user_id) rather than a new table.
--
-- Both new columns are nullable-safe defaults (false), so every
-- existing site/assignment behaves exactly as it does today until an
-- admin opts in.

begin;

alter table public.sites
    add column block_self_clock_out_outside_geofence boolean not null default false;

alter table public.site_assignments
    add column is_exempt_from_restrictions boolean not null default false;

-- ============================================================
-- 1. create_prosm_time_site / update_prosm_time_site - one more
--    trailing param, same "drop the exact old signature, create the
--    extended one" convention already used three times this session.
-- ============================================================

drop function if exists public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean);

create function public.create_prosm_time_site(
    p_name text,
    p_latitude double precision,
    p_longitude double precision,
    p_display_address text default null,
    p_allowed_radius_meters integer default 100,
    p_gps_accuracy_tolerance_meters integer default 50,
    p_timezone text default 'UTC',
    p_attendance_allowed boolean default true,
    p_geofence_required boolean default true,
    p_camera_required boolean default false,
    p_kiosk_mode text default 'personal_device_only',
    p_environmental_tag_enabled boolean default false,
    p_grace_tolerance_minutes integer default 5,
    p_shift_start_time time default null,
    p_shift_end_time time default null,
    p_overtime_start_time time default null,
    p_late_deduction_start_time time default null,
    p_break_rounding_mode text default 'cumulative',
    p_block_self_clock_in_after_grace boolean default false,
    p_block_self_clock_out_outside_geofence boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CREATE A NEW SITE';
    end if;

    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'SITE NAME IS REQUIRED';
    end if;

    if p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    insert into sites (
        organization_id, name, display_address, latitude, longitude,
        allowed_radius_meters, gps_accuracy_tolerance_meters, timezone,
        attendance_allowed, geofence_required, camera_required,
        kiosk_mode, environmental_tag_enabled, grace_tolerance_minutes,
        shift_start_time, shift_end_time, overtime_start_time, late_deduction_start_time,
        break_rounding_mode, block_self_clock_in_after_grace, block_self_clock_out_outside_geofence
    ) values (
        v_caller_org, trim(p_name), p_display_address, p_latitude, p_longitude,
        p_allowed_radius_meters, p_gps_accuracy_tolerance_meters, p_timezone,
        p_attendance_allowed, p_geofence_required, p_camera_required,
        p_kiosk_mode, p_environmental_tag_enabled, p_grace_tolerance_minutes,
        p_shift_start_time, p_shift_end_time, p_overtime_start_time, p_late_deduction_start_time,
        p_break_rounding_mode, p_block_self_clock_in_after_grace, p_block_self_clock_out_outside_geofence
    )
    returning id into v_site_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (
        v_caller_org, v_caller_id, 'SITE_CREATED', 'sites', v_site_id,
        'Site ' || trim(p_name) || ' created.',
        jsonb_build_object('name', trim(p_name), 'latitude', p_latitude, 'longitude', p_longitude, 'allowedRadiusMeters', p_allowed_radius_meters)
    );

    return jsonb_build_object('success', true, 'siteId', v_site_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean, boolean) from public, anon;
grant execute on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean, boolean) to authenticated;

drop function if exists public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean);

create function public.update_prosm_time_site(
    p_site_id uuid,
    p_name text default null,
    p_display_address text default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_allowed_radius_meters integer default null,
    p_gps_accuracy_tolerance_meters integer default null,
    p_timezone text default null,
    p_attendance_allowed boolean default null,
    p_geofence_required boolean default null,
    p_camera_required boolean default null,
    p_kiosk_mode text default null,
    p_environmental_tag_enabled boolean default null,
    p_grace_tolerance_minutes integer default null,
    p_is_active boolean default null,
    p_shift_start_time time default null,
    p_shift_end_time time default null,
    p_overtime_start_time time default null,
    p_late_deduction_start_time time default null,
    p_break_rounding_mode text default null,
    p_block_self_clock_in_after_grace boolean default null,
    p_clear_shift_policy boolean default false,
    p_block_self_clock_out_outside_geofence boolean default null
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
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            and p_site_id = any(public.current_prosm_time_managed_site_ids())
        )
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    if p_break_rounding_mode is not null and p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    update sites set
        name = coalesce(p_name, name),
        display_address = coalesce(p_display_address, display_address),
        latitude = coalesce(p_latitude, latitude),
        longitude = coalesce(p_longitude, longitude),
        allowed_radius_meters = coalesce(p_allowed_radius_meters, allowed_radius_meters),
        gps_accuracy_tolerance_meters = coalesce(p_gps_accuracy_tolerance_meters, gps_accuracy_tolerance_meters),
        timezone = coalesce(p_timezone, timezone),
        attendance_allowed = coalesce(p_attendance_allowed, attendance_allowed),
        geofence_required = coalesce(p_geofence_required, geofence_required),
        camera_required = coalesce(p_camera_required, camera_required),
        kiosk_mode = coalesce(p_kiosk_mode, kiosk_mode),
        environmental_tag_enabled = coalesce(p_environmental_tag_enabled, environmental_tag_enabled),
        grace_tolerance_minutes = coalesce(p_grace_tolerance_minutes, grace_tolerance_minutes),
        is_active = coalesce(p_is_active, is_active),
        shift_start_time = case when p_clear_shift_policy then null else coalesce(p_shift_start_time, shift_start_time) end,
        shift_end_time = case when p_clear_shift_policy then null else coalesce(p_shift_end_time, shift_end_time) end,
        overtime_start_time = case when p_clear_shift_policy then null else coalesce(p_overtime_start_time, overtime_start_time) end,
        late_deduction_start_time = case when p_clear_shift_policy then null else coalesce(p_late_deduction_start_time, late_deduction_start_time) end,
        break_rounding_mode = coalesce(p_break_rounding_mode, break_rounding_mode),
        block_self_clock_in_after_grace = case when p_clear_shift_policy then false else coalesce(p_block_self_clock_in_after_grace, block_self_clock_in_after_grace) end,
        -- Not reset by p_clear_shift_policy - this is a geofence policy
        -- (tied to geofence_required), not a shift-hours one.
        block_self_clock_out_outside_geofence = coalesce(p_block_self_clock_out_outside_geofence, block_self_clock_out_outside_geofence),
        updated_at = now()
    where id = p_site_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_caller_org, v_caller_id, 'SITE_UPDATED', 'sites', p_site_id, 'Site ' || v_site.name || ' updated.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'UPDATE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean, boolean) to authenticated;

-- ============================================================
-- 2. clock_in_prosm_time_attendance - the existing after-grace block
--    now skips when the caller's own site_assignments row for this
--    site is exempt.
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

        -- § live UX review, user-directed - "after the grace period,
        -- can the employee still self clock-in, or does it say
        -- contact your manager?" A site with the toggle on and a
        -- configured shift start simply refuses self clock-in past
        -- shift_start_time + grace_tolerance_minutes (site-local
        -- time) - the frontend recognizes this exact marker string
        -- and shows "contact your manager" instead of a generic
        -- error. The Manager resolves it with the already-existing,
        -- already-site-scoped, already-reason-required
        -- admin_clock_in_prosm_time_attendance - no change needed
        -- there. An employee marked exempt on this site's own
        -- assignment row skips this block entirely (§ per-site
        -- exemption list).
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

-- ============================================================
-- 3. clock_out_prosm_time_attendance - the new block. When the
--    session's site has the toggle on, the caller is not exempt, and
--    the geofence check comes back checked+outside, this now raises
--    CLOCK_OUT_BLOCKED_CONTACT_MANAGER BEFORE any state changes
--    (mirrors clock-in's own raise-before-insert posture) instead of
--    recording a geofence_exception. A site with the toggle off (the
--    default) keeps today's exact exception+notification behavior.
-- ============================================================

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

revoke all on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision) from public, anon;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision) to authenticated;

-- ============================================================
-- 4. set_prosm_time_site_assignment_exemption - a small dedicated RPC
--    (not folded into set_prosm_time_site_assignment, which is about
--    role/creating the assignment - this only ever toggles the
--    exemption flag on an assignment that must already exist), same
--    authorization shape as every other site.manage mutation.
-- ============================================================

create function public.set_prosm_time_site_assignment_exemption(
    p_site_id uuid,
    p_user_id uuid,
    p_is_exempt boolean
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
    v_target users%rowtype;
    v_assignment_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            and p_site_id = any(public.current_prosm_time_managed_site_ids())
        )
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    update site_assignments
    set is_exempt_from_restrictions = p_is_exempt
    where site_id = p_site_id and user_id = p_user_id
    returning id into v_assignment_id;

    if v_assignment_id is null then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, p_user_id, 'SITE_ASSIGNMENT_EXEMPTION_SET', 'site_assignments', v_assignment_id,
        v_target.full_name || (case when p_is_exempt then ' exempted from ' else ' no longer exempted from ' end) || v_site.name || ' time/geofence restrictions.'
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'SET PROSM TIME SITE ASSIGNMENT EXEMPTION FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.set_prosm_time_site_assignment_exemption(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_prosm_time_site_assignment_exemption(uuid, uuid, boolean) to authenticated;

commit;
