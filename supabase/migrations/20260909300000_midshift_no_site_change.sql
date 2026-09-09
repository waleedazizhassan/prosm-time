-- PROSM Time - user-directed: mid-shift "Change Site" needs the same
-- "no site / walk-in" option that clock-in already has - an employee
-- moving somewhere with no registered site should still be able to
-- record the move, with a real GPS sample captured at that moment
-- (reusing the exact same site_change_events.latitude/longitude/
-- accuracy_meters columns already used for the geofence re-check on a
-- real site change - no new location-capture mechanism). No photo is
-- required for this action (matches the existing Change Site flow,
-- which never required one). Mirrors clock_in_prosm_time_attendance's
-- own no-site path exactly: p_new_site_id null means "no site", and a
-- manual_location_label is required in that case so reports never show
-- a blank site - the identical reasoning that RPC's own header comment
-- already documents.

begin;

alter table public.site_change_events
    alter column new_site_id drop not null,
    add column manual_location_label text;

create or replace function public.change_prosm_time_site(
    p_break_id uuid,
    p_new_site_id uuid default null,
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
    v_break break_events%rowtype;
    v_session attendance_sessions%rowtype;
    v_old_site sites%rowtype;
    v_new_site sites%rowtype;
    v_old_site_id uuid;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_exceeded boolean;
    v_change_id uuid;
    v_manual_label text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_caller_org := public.current_prosm_time_organization_id();

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    select * into v_session from attendance_sessions where id = v_break.attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO CHANGE SITE'; end if;

    v_old_site_id := v_session.site_id;

    if p_new_site_id is null then
        if v_old_site_id is null then
            raise exception 'YOU ARE ALREADY WORKING WITHOUT A REGISTERED SITE';
        end if;
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
        -- Same org-wide no-site radius check clock-in's own walk-in
        -- path already uses - real GPS re-verified server-side, not
        -- merely accepted from the client.
        v_walkin_check := public.compute_prosm_time_geofence_check(null, p_latitude, p_longitude, p_accuracy_meters);
        if not coalesce((v_walkin_check->>'checked')::boolean, false) then
            raise exception 'UNABLE TO VERIFY YOUR LOCATION - LOCATION SERVICES ARE REQUIRED TO CHANGE SITE';
        end if;
    else
        select * into v_new_site from sites where id = p_new_site_id and organization_id = v_caller_org and is_active = true;
        if v_new_site.id is null then raise exception 'SITE NOT FOUND'; end if;

        if v_old_site_id = p_new_site_id then
            raise exception 'YOU ARE ALREADY AT THIS SITE';
        end if;

        -- Same walk-in authorization posture as clock_in_prosm_time_
        -- attendance's own unassigned-site path - assigned OR
        -- verifiably inside the new site's geofence right now.
        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_new_site_id and user_id = v_caller_id;
        if v_is_exempt is null then
            if v_new_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_new_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
        end if;
    end if;

    if v_old_site_id is not null then
        select * into v_old_site from sites where id = v_old_site_id;
    end if;

    -- Same "nothing to check against" posture end_prosm_time_break
    -- already uses for a no-site session.
    v_exceeded := coalesce(extract(epoch from (now() - v_break.started_at)) / 60 > v_old_site.break_max_duration_minutes, false);

    update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;

    -- A project belongs to a specific site - the old one no longer
    -- applies once the session moves (to a different site, or off any
    -- registered site at all).
    update attendance_sessions
    set site_id = p_new_site_id, project_id = null, manual_location_label = case when p_new_site_id is null then v_manual_label else null end
    where id = v_session.id;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters, manual_location_label)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters, v_manual_label)
    returning id into v_change_id;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'siteChangeId', v_change_id, 'newSiteId', p_new_site_id, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'CHANGE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

commit;
