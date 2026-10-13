-- Audit 2026-10-12, item 2.2 - the Location Violations report read only
-- location_plausibility_flags (impossible travel), so a clock-in 30 km
-- outside a site's work area - which creates a geofence exception and
-- notifies the owner - never showed in it.
--
-- The report now lists both kinds, told apart by violation_type:
--   'outside_work_area'    - a geofence exception (clock in/out or
--                            presence monitoring), with the employee's
--                            reason and the review status;
--   'implausible_location' - a location plausibility flag, as before.
-- Same access and site scoping as before: the Owner sees the whole
-- organisation, an attendance.view holder only the sites they manage.
-- The result columns change, so the function is dropped and recreated.

begin;

drop function if exists public.list_prosm_time_report_location_violations(date, date);

create function public.list_prosm_time_report_location_violations(p_start_date date, p_end_date date)
returns table (
    flag_id uuid,
    violation_type text,
    user_full_name text,
    site_name text,
    implied_speed_kmh double precision,
    distance_meters double precision,
    occurred_at timestamptz,
    employee_reason text,
    review_status text
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_is_owner boolean;
    v_managed uuid[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_is_owner := public.current_prosm_time_user_is_owner();
    if not v_is_owner
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    v_managed := coalesce(public.current_prosm_time_managed_site_ids(), array[]::uuid[]);

    return query
    select * from (
        select
            lpf.id, 'implausible_location'::text, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
            lpf.implied_speed_kmh, lpf.distance_meters, lpf.occurred_at,
            null::text, null::text
        from location_plausibility_flags lpf
        join users u on u.id = lpf.user_id
        left join sites s on s.id = lpf.site_id
        where lpf.organization_id = v_org
          and lpf.occurred_at::date between p_start_date and p_end_date
          and (v_is_owner or lpf.site_id = any(v_managed))

        union all

        select
            ge.id, 'outside_work_area'::text, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
            null::double precision, ge.distance_meters, coalesce(ev.occurred_at, ge.created_at),
            ge.employee_reason, ge.status
        from geofence_exceptions ge
        join users u on u.id = ge.user_id
        left join attendance_events ev on ev.id = ge.attendance_event_id
        left join attendance_sessions ats on ats.id = ev.session_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        left join sites s on s.id = coalesce(ats.site_id, ps.site_id)
        where ge.organization_id = v_org
          and coalesce(ev.occurred_at, ge.created_at)::date between p_start_date and p_end_date
          and (v_is_owner or coalesce(ats.site_id, ps.site_id) = any(v_managed))
    ) violations
    order by 7 desc;
end;
$function$;

revoke execute on function public.list_prosm_time_report_location_violations(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_location_violations(date, date) to authenticated, service_role;

commit;
