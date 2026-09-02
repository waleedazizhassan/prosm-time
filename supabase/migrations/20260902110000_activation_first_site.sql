-- PROSM Time - explicit user-directed request: "during activation I
-- want a field to type your site name, so the PDF sheet / Attendance
-- Record never end up with a blank site." Root cause: bootstrap_
-- prosm_time_organization() (20260831110000) creates the organization
-- and the Owner but never a first Site - a brand-new org has zero
-- sites until the Owner manually visits Sites -> Add Site, so every
-- clock-in until then falls into the "no site selected" path
-- (site_id null), which is exactly what shows up blank in reports.
--
-- Adds an optional p_site_name to the same atomic bootstrap
-- transaction: when the Owner supplies a site name during activation,
-- a real first Site row is created (and the Owner assigned to it as
-- its manager) in the same transaction as the organization/Owner
-- themselves - no separate, non-atomic follow-up call. Real GPS
-- coordinates are not collected at activation (a text-only signup
-- form, no map/geolocation step) - the site is created with
-- geofence_required = false and camera_required = true (the exact
-- same photographic-verification substitute already used for a
-- site-optional clock-in, ClockInOutCard.tsx) until the Owner fills
-- in the real coordinates via Sites -> Edit.

begin;

drop function if exists public.bootstrap_prosm_time_organization(text, uuid, text, text, text, uuid, integer, integer, timestamptz);

create or replace function public.bootstrap_prosm_time_organization(
    p_organization_name text,
    p_auth_user_id uuid,
    p_owner_email text,
    p_owner_full_name text,
    p_license_number text,
    p_plan_id uuid,
    p_max_users integer,
    p_max_devices integer,
    p_expires_at timestamptz,
    p_site_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_organization_id uuid;
    v_user_id uuid;
    v_owner_role_id uuid;
    v_site_id uuid;
begin
    if p_organization_name is null or length(trim(p_organization_name)) = 0 then
        raise exception 'ORGANIZATION NAME IS REQUIRED';
    end if;

    if p_owner_email is null or length(trim(p_owner_email)) = 0 then
        raise exception 'OWNER EMAIL IS REQUIRED';
    end if;

    if p_auth_user_id is null then
        raise exception 'AUTH USER ID IS REQUIRED';
    end if;

    if p_license_number is null or length(trim(p_license_number)) = 0 then
        raise exception 'LICENSE NUMBER IS REQUIRED';
    end if;

    select id into v_owner_role_id from roles where role_key = 'owner';
    if v_owner_role_id is null then
        raise exception 'OWNER ROLE NOT FOUND - ROLE CATALOG NOT SEEDED';
    end if;

    insert into organizations (organization_code, name, status)
    values (public.generate_organization_code(), p_organization_name, 'active')
    returning id into v_organization_id;

    insert into organization_settings (organization_id)
    values (v_organization_id);

    insert into license_activation_state (
        organization_id, license_number, status, plan_id, max_users, max_devices, expires_at
    ) values (
        v_organization_id, p_license_number, 'ACTIVE', p_plan_id, p_max_users, p_max_devices, p_expires_at
    );

    insert into users (
        auth_user_id, organization_id, role_id, email, full_name, status, is_owner
    ) values (
        p_auth_user_id, v_organization_id, v_owner_role_id, lower(trim(p_owner_email)), p_owner_full_name, 'active', true
    )
    returning id into v_user_id;

    if p_site_name is not null and length(trim(p_site_name)) > 0 then
        insert into sites (
            organization_id, name, latitude, longitude, geofence_required, camera_required
        ) values (
            v_organization_id, trim(p_site_name), 0, 0, false, true
        )
        returning id into v_site_id;

        insert into site_assignments (site_id, user_id, role_at_site, assigned_by)
        values (v_site_id, v_user_id, 'manager', v_user_id);
    end if;

    insert into audit_logs (
        organization_id, actor_user_id, action, entity_name, entity_id, description, context
    ) values (
        v_organization_id, v_user_id, 'ORGANIZATION_ACTIVATED', 'organizations', v_organization_id,
        'Organization activated and Owner account established via PROSM Management activation code.',
        jsonb_build_object('licenseNumber', p_license_number, 'ownerEmail', p_owner_email, 'siteId', v_site_id)
    );

    return jsonb_build_object(
        'success', true,
        'organizationId', v_organization_id,
        'userId', v_user_id,
        'siteId', v_site_id
    );
exception
    when unique_violation then
        raise exception 'BOOTSTRAP PROSM TIME ORGANIZATION FAILED: A record with this identifier already exists (%).', sqlerrm;
    when others then
        raise exception 'BOOTSTRAP PROSM TIME ORGANIZATION FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.bootstrap_prosm_time_organization(text, uuid, text, text, text, uuid, integer, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.bootstrap_prosm_time_organization(text, uuid, text, text, text, uuid, integer, integer, timestamptz, text) to service_role;

commit;
