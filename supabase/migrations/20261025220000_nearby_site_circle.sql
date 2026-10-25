-- PROSM Time v2.3.43, step 13 (item 15): the map draws the work-area circle
-- of the site the employee is standing in, even when it is not one of their
-- assigned sites (a walk-in site). list_prosm_time_nearby_sites already
-- returns only sites whose area the caller is inside; it now also returns
-- that site's centre and radius (the caller is physically there). Otherwise
-- unchanged (20260903170100).

begin;

drop function if exists public.list_prosm_time_nearby_sites(double precision, double precision, double precision);
create function public.list_prosm_time_nearby_sites(
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null
)
returns table(id uuid, name text, display_address text, distance_meters double precision, camera_required boolean,
              latitude double precision, longitude double precision, allowed_radius_meters integer)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site record;
    v_check jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

    if p_latitude is null or p_longitude is null then
        return;
    end if;

    for v_site in
        select s.id, s.name, s.display_address, s.camera_required, s.latitude, s.longitude, s.allowed_radius_meters
        from sites s
        where s.organization_id = v_caller_org
        and s.is_active = true
        and s.attendance_allowed = true
        and s.geofence_required = true
        and not exists (select 1 from site_assignments sa where sa.site_id = s.id and sa.user_id = v_caller_id)
    loop
        v_check := public.compute_prosm_time_geofence_check(v_site.id, p_latitude, p_longitude, p_accuracy_meters);
        if coalesce((v_check->>'checked')::boolean, false) and coalesce((v_check->>'withinGeofence')::boolean, false) then
            id := v_site.id;
            name := v_site.name;
            display_address := v_site.display_address;
            distance_meters := (v_check->>'distanceMeters')::double precision;
            camera_required := v_site.camera_required;
            latitude := v_site.latitude;
            longitude := v_site.longitude;
            allowed_radius_meters := v_site.allowed_radius_meters;
            return next;
        end if;
    end loop;
end;
$function$;

revoke all on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) from public, anon;
grant execute on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) to authenticated;

commit;
