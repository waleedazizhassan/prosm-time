-- PROSM Time - live UX review, user-directed: a real "Change Site"
-- workflow for an employee who moves between sites mid-shift ("I'm at
-- El Agami, I press Pause before leaving, the button becomes 'Change
-- Site', I press it once I arrive at El Amreya, the move is recorded
-- in every record, and the button goes back to being 'Pause'"). This
-- does NOT clock the employee out - it ends the active break, moves
-- the still-open attendance_sessions row onto the new site, and
-- records the move as real per-session history (not just an audit-log
-- line nobody sees) so Attendance Record can show it inline.
--
-- Authorization for the new site mirrors clock_in_prosm_time_
-- attendance's own walk-in path exactly (20260903170000): assigned OR
-- verifiably inside that site's geofence right now, re-checked here
-- server-side - never a permanent site_assignments row, same one-time
-- walk-in posture.

begin;

create table public.site_change_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    attendance_session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    old_site_id uuid references public.sites(id),
    new_site_id uuid not null references public.sites(id),
    latitude double precision,
    longitude double precision,
    accuracy_meters double precision,
    changed_at timestamptz not null default now()
);

create index site_change_events_organization_id_idx on public.site_change_events(organization_id);
create index site_change_events_attendance_session_id_idx on public.site_change_events(attendance_session_id);

alter table public.site_change_events enable row level security;
revoke all on public.site_change_events from anon, authenticated;
grant select on public.site_change_events to authenticated;

create policy "site change events visible to subject or attendance.view"
on public.site_change_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (new_site_id = any(public.current_prosm_time_managed_site_ids()) or old_site_id = any(public.current_prosm_time_managed_site_ids()))
            )
        )
    )
);

create function public.change_prosm_time_site(
    p_break_id uuid,
    p_new_site_id uuid,
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
    v_break break_events%rowtype;
    v_session attendance_sessions%rowtype;
    v_old_site sites%rowtype;
    v_new_site sites%rowtype;
    v_old_site_id uuid;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_exceeded boolean;
    v_change_id uuid;
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

    select * into v_new_site from sites where id = p_new_site_id and organization_id = v_caller_org and is_active = true;
    if v_new_site.id is null then raise exception 'SITE NOT FOUND'; end if;

    v_old_site_id := v_session.site_id;
    if v_old_site_id = p_new_site_id then
        raise exception 'YOU ARE ALREADY AT THIS SITE';
    end if;

    -- Same walk-in authorization posture as clock_in_prosm_time_
    -- attendance's own unassigned-site path - assigned OR verifiably
    -- inside the new site's geofence right now.
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

    if v_old_site_id is not null then
        select * into v_old_site from sites where id = v_old_site_id;
    end if;

    -- Same "nothing to check against" posture end_prosm_time_break
    -- already uses for a no-site session.
    v_exceeded := coalesce(extract(epoch from (now() - v_break.started_at)) / 60 > v_old_site.break_max_duration_minutes, false);

    update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;

    -- A project belongs to a specific site (project_assignments/
    -- projects.site_id) - the old one no longer applies once the
    -- session moves to a different site.
    update attendance_sessions set site_id = p_new_site_id, project_id = null where id = v_session.id;

    insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_session.id, v_caller_id, v_old_site_id, p_new_site_id, p_latitude, p_longitude, p_accuracy_meters)
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

revoke all on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.change_prosm_time_site(uuid, uuid, double precision, double precision, double precision) to authenticated;

commit;
