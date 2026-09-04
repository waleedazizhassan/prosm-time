-- PROSM Time - live UX review, user-directed: "look at the site Edit
-- form, you'll find things that deserve to be in Settings."
--
-- 1. GPS accuracy tolerance, break rounding mode, and grace tolerance
--    minutes are policy decisions that are almost always uniform
--    across an organization's sites, not a genuine per-site attribute
--    (unlike GPS coordinates, radius, or shift hours, which really do
--    vary site to site). They now have organization-wide DEFAULTS on
--    Settings, exactly mirroring the no-site-radius pattern
--    (20260904110000) - and stay fully editable per-site in the site
--    Edit form too, since a specific site may still need to diverge
--    (a new site's create form pre-fills from these defaults; an
--    existing site's own saved value is untouched by this migration).
--
-- 2. environmental_tag_enabled - audited and confirmed dead: saved on
--    every site create/update, but never read anywhere in the client
--    to gate any real behavior. Removed outright rather than moved,
--    per explicit user direction, instead of carrying a vestigial
--    field into the v1.0 release.

begin;

-- ============================================================
-- 1. Organization-wide site-policy defaults.
-- ============================================================

alter table public.organization_settings
    add column default_gps_accuracy_tolerance_meters integer not null default 50,
    add column default_break_rounding_mode text not null default 'cumulative',
    add column default_grace_tolerance_minutes integer not null default 5;

alter table public.organization_settings
    add constraint organization_settings_default_break_rounding_mode_check
    check (default_break_rounding_mode in ('cumulative', 'full_hour'));

create or replace function public.set_prosm_time_site_defaults(
    p_gps_accuracy_tolerance_meters integer,
    p_break_rounding_mode text,
    p_grace_tolerance_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY SET SITE DEFAULTS';
    end if;

    if p_gps_accuracy_tolerance_meters is null or p_gps_accuracy_tolerance_meters <= 0 then
        raise exception 'GPS ACCURACY TOLERANCE MUST BE GREATER THAN ZERO';
    end if;

    if p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    if p_grace_tolerance_minutes is null or p_grace_tolerance_minutes < 0 then
        raise exception 'GRACE TOLERANCE MUST NOT BE NEGATIVE';
    end if;

    v_org_id := public.current_prosm_time_organization_id();
    if v_org_id is null then
        raise exception 'NO ORGANIZATION FOR THIS SESSION';
    end if;

    update organization_settings set
        default_gps_accuracy_tolerance_meters = p_gps_accuracy_tolerance_meters,
        default_break_rounding_mode = p_break_rounding_mode,
        default_grace_tolerance_minutes = p_grace_tolerance_minutes,
        updated_at = now()
    where organization_id = v_org_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME SITE DEFAULTS FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.set_prosm_time_site_defaults(integer, text, integer) from public, anon;
grant execute on function public.set_prosm_time_site_defaults(integer, text, integer) to authenticated;

-- ============================================================
-- 2. create_prosm_time_site / update_prosm_time_site - drop the
--    environmental_tag_enabled parameter (dead field, see header).
-- ============================================================

drop function if exists public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean, boolean);

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

revoke all on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, integer, time, time, time, time, text, boolean, boolean) from public, anon;
grant execute on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, integer, time, time, time, time, text, boolean, boolean) to authenticated;

drop function if exists public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean, boolean);

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

revoke all on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, integer, boolean, time, time, time, time, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, integer, boolean, time, time, time, time, text, boolean, boolean, boolean) to authenticated;

-- ============================================================
-- 3. Drop the now-unreferenced dead column.
-- ============================================================

alter table public.sites drop column environmental_tag_enabled;

commit;
