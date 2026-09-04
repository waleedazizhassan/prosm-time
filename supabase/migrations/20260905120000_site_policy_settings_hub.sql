-- PROSM Time - live UX review, user-directed: consolidate GPS
-- accuracy tolerance, grace tolerance, the whole shift-policy block
-- (hours, overtime/late-deduction start, break rounding, both self-
-- service block toggles) and exempt-employee management into a single
-- "Site Policy" hub on Settings (site picked from a dropdown), removed
-- entirely from the per-site Edit form (which now only owns identity/
-- location/capability: name, address, coordinates, radius, timezone,
-- kiosk mode, attendance/geofence/camera toggles, active status).
--
-- Only the create-site path needs a real schema/RPC change: since the
-- Edit form no longer collects these fields at all, a brand-new site
-- must derive its GPS tolerance / break rounding / grace tolerance
-- from the organization's own policy defaults (20260905100000)
-- SERVER-SIDE rather than relying on the client to fetch-then-send
-- them - a stray client that omits these params (any future
-- integration, not just this form) still gets the org's real defaults
-- instead of the old hardcoded literals (50 / 'cumulative' / 5).
-- update_prosm_time_site is untouched - it was already fully
-- coalesce-based, so a caller (Settings' new hub) that sends only the
-- policy fields it's editing already leaves every other column alone,
-- and the Edit form omitting policy fields already leaves them alone
-- too. No signature change here either (parameter defaults are not
-- part of a function's identity) - create or replace is sufficient.

begin;

create or replace function public.create_prosm_time_site(
    p_name text,
    p_latitude double precision,
    p_longitude double precision,
    p_display_address text default null,
    p_allowed_radius_meters integer default 100,
    p_gps_accuracy_tolerance_meters integer default null,
    p_timezone text default 'UTC',
    p_attendance_allowed boolean default true,
    p_geofence_required boolean default true,
    p_camera_required boolean default false,
    p_kiosk_mode text default 'personal_device_only',
    p_grace_tolerance_minutes integer default null,
    p_shift_start_time time default null,
    p_shift_end_time time default null,
    p_overtime_start_time time default null,
    p_late_deduction_start_time time default null,
    p_break_rounding_mode text default null,
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
    v_default_gps_accuracy_tolerance_meters integer;
    v_default_break_rounding_mode text;
    v_default_grace_tolerance_minutes integer;
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

    select default_gps_accuracy_tolerance_meters, default_break_rounding_mode, default_grace_tolerance_minutes
        into v_default_gps_accuracy_tolerance_meters, v_default_break_rounding_mode, v_default_grace_tolerance_minutes
        from organization_settings where organization_id = v_caller_org;

    p_gps_accuracy_tolerance_meters := coalesce(p_gps_accuracy_tolerance_meters, v_default_gps_accuracy_tolerance_meters, 50);
    p_break_rounding_mode := coalesce(p_break_rounding_mode, v_default_break_rounding_mode, 'cumulative');
    p_grace_tolerance_minutes := coalesce(p_grace_tolerance_minutes, v_default_grace_tolerance_minutes, 5);

    if p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    insert into sites (
        organization_id, name, display_address, latitude, longitude,
        allowed_radius_meters, gps_accuracy_tolerance_meters, timezone,
        attendance_allowed, geofence_required, camera_required,
        kiosk_mode, grace_tolerance_minutes,
        shift_start_time, shift_end_time, overtime_start_time, late_deduction_start_time,
        break_rounding_mode, block_self_clock_in_after_grace, block_self_clock_out_outside_geofence
    ) values (
        v_caller_org, trim(p_name), p_display_address, p_latitude, p_longitude,
        p_allowed_radius_meters, p_gps_accuracy_tolerance_meters, p_timezone,
        p_attendance_allowed, p_geofence_required, p_camera_required,
        p_kiosk_mode, p_grace_tolerance_minutes,
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

commit;
