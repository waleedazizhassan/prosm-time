-- PROSM Time - two follow-ups to the walk-in geofence clock-in
-- (20260903170000), both needed for a walk-in to behave correctly on
-- the client, not just succeed on the backend:
--
-- 1. list_prosm_time_nearby_sites() now also returns camera_required -
--    the frontend's Clock In flow decides whether to force the camera
--    modal open per-site (a client-side UX gate, not itself a
--    server-enforced rule) and had no way to know this for an
--    unassigned site's suggestion; without it a walk-in could silently
--    skip a site's real evidence-photo requirement.
--
-- 2. The `sites` RLS policy only ever allowed an Owner or an assigned
--    member to read a site row at all - a walk-in employee who
--    successfully clocks in at an unassigned-but-in-range site could
--    never read that site's own record afterward either (the
--    Dashboard's "currently at" card, the Clock Out camera-required
--    check) since nothing about being currently clocked in there
--    granted visibility. Extended to also allow reading a site the
--    caller has a real open (clocked_in) attendance session at right
--    now - the same "currently, verifiably associated with this site"
--    concept the walk-in clock-in itself already relies on.

begin;

drop function if exists public.list_prosm_time_nearby_sites(double precision, double precision, double precision);

create function public.list_prosm_time_nearby_sites(
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null
)
returns table(id uuid, name text, display_address text, distance_meters double precision, camera_required boolean)
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
        select s.id, s.name, s.display_address, s.camera_required
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
            return next;
        end if;
    end loop;
end;
$function$;

revoke all on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) from public, anon;
grant execute on function public.list_prosm_time_nearby_sites(double precision, double precision, double precision) to authenticated;

drop policy if exists "members can view sites in own organization" on public.sites;

create policy "members can view sites in own organization"
on public.sites for select to authenticated
using (
    organization_id = current_prosm_time_organization_id()
    and (
        current_prosm_time_user_is_owner()
        or id = any(current_prosm_time_assigned_site_ids())
        or exists (
            select 1 from attendance_sessions ats
            where ats.site_id = sites.id and ats.user_id = current_prosm_time_user_id() and ats.status = 'clocked_in'
        )
    )
);

commit;
