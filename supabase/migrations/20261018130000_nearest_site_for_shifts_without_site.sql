-- Owner 2026-10-18: "someone who clocks in without being tied to a site:
-- their SOS should reach a site manager, and that manager should have
-- authority over them as if they were assigned to the site". Decision:
-- the nearest site's managers, plus the Owner.
--
-- * Clocked in at a site without being assigned: that site already
--   decides (session site_id) - nothing changes.
-- * Clocked in with no site: each shift now has a responsible site
--   (attendance_sessions.responsible_site_id) - the site itself when one
--   is chosen, otherwise the organisation's nearest active site to where
--   the person clocked in (or moved to, on a change to "no site").
-- * Everything that was scoped to the shift's site now uses
--   coalesce(site_id, responsible_site_id): what managers can see
--   (sessions, events, breaks, photos, corrections, exceptions, presence,
--   site changes, offline-time reviews, fake-location flags, SOS), who
--   gets SOS alerts and out-of-area notifications, and the People list
--   (someone working at a managed site right now is listed, as if
--   assigned, for that shift).
-- * Fix found on the way: exceptions found during a shift (presence
--   monitoring, no clock-in/out event) were not visible to the site's
--   managers at all - the policy only followed clock-in/out events.

begin;

alter table public.attendance_sessions add column if not exists responsible_site_id uuid references public.sites(id) on delete set null;
create index if not exists attendance_sessions_responsible_site_id_idx on public.attendance_sessions(responsible_site_id);

-- The organisation's nearest active site to a position (straight-line distance).
create or replace function public.prosm_time_nearest_site(p_organization_id uuid, p_latitude double precision, p_longitude double precision)
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select s.id
    from sites s
    where s.organization_id = p_organization_id
      and s.is_active
      and p_latitude is not null and p_longitude is not null
    order by 6371000 * 2 * asin(sqrt(
        power(sin(radians(s.latitude - p_latitude) / 2), 2) +
        cos(radians(p_latitude)) * cos(radians(s.latitude)) *
        power(sin(radians(s.longitude - p_longitude) / 2), 2)
    ))
    limit 1;
$function$;

revoke execute on function public.prosm_time_nearest_site(uuid, double precision, double precision) from public, anon, authenticated;

-- Set at clock-in (every clock-in path records a clock_in event).
create or replace function public.prosm_time_set_responsible_site_on_clock_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if new.event_type = 'clock_in' then
        update attendance_sessions ats
        set responsible_site_id = coalesce(ats.site_id, public.prosm_time_nearest_site(ats.organization_id, new.latitude, new.longitude))
        where ats.id = new.session_id;
    end if;
    return new;
end;
$function$;

drop trigger if exists attendance_events_set_responsible_site on public.attendance_events;
create trigger attendance_events_set_responsible_site
after insert on public.attendance_events
for each row execute function public.prosm_time_set_responsible_site_on_clock_in();

-- ...and on a mid-shift site change.
create or replace function public.prosm_time_set_responsible_site_on_site_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    update attendance_sessions
    set responsible_site_id = coalesce(new.new_site_id, public.prosm_time_nearest_site(new.organization_id, new.latitude, new.longitude), responsible_site_id)
    where id = new.attendance_session_id;
    return new;
end;
$function$;

drop trigger if exists site_change_events_set_responsible_site on public.site_change_events;
create trigger site_change_events_set_responsible_site
after insert on public.site_change_events
for each row execute function public.prosm_time_set_responsible_site_on_site_change();

-- Existing shifts: from their clock-in position.
update attendance_sessions ats
set responsible_site_id = coalesce(ats.site_id, public.prosm_time_nearest_site(ats.organization_id, e.latitude, e.longitude))
from attendance_events e
where e.session_id = ats.id and e.event_type = 'clock_in' and ats.responsible_site_id is null;

-- Rows that carry their own site: filled from the shift when they have none.
create or replace function public.prosm_time_fill_site_from_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_session_id uuid;
begin
    if new.site_id is not null then
        return new;
    end if;
    if tg_table_name = 'sos_alerts' then
        v_session_id := coalesce(new.attendance_session_id, (select ps.attendance_session_id from presence_sessions ps where ps.id = new.presence_session_id));
    elsif tg_table_name = 'mock_location_flags' then
        select e.session_id into v_session_id from attendance_events e where e.id = new.attendance_event_id;
    elsif tg_table_name = 'offline_time_reviews' then
        if new.source_table = 'attendance_events' then
            select e.session_id into v_session_id from attendance_events e where e.id = new.source_id;
        elsif new.source_table = 'break_events' then
            select b.attendance_session_id into v_session_id from break_events b where b.id = new.source_id;
        else
            select c.attendance_session_id into v_session_id from site_change_events c where c.id = new.source_id;
        end if;
    end if;
    if v_session_id is not null then
        select coalesce(ats.site_id, ats.responsible_site_id) into new.site_id from attendance_sessions ats where ats.id = v_session_id;
    end if;
    -- Nested, so site_name is only read on sos_alerts (the other tables have no such column).
    if tg_table_name = 'sos_alerts' then
        if new.site_id is not null and new.site_name is null then
            select name into new.site_name from sites where id = new.site_id;
        end if;
    end if;
    return new;
end;
$function$;

-- Named to run after sos_alerts_fill_context (same-event triggers run in name order).
drop trigger if exists sos_alerts_zz_fill_site_from_shift on public.sos_alerts;
create trigger sos_alerts_zz_fill_site_from_shift before insert on public.sos_alerts
for each row execute function public.prosm_time_fill_site_from_shift();
drop trigger if exists mock_location_flags_fill_site_from_shift on public.mock_location_flags;
create trigger mock_location_flags_fill_site_from_shift before insert on public.mock_location_flags
for each row execute function public.prosm_time_fill_site_from_shift();
drop trigger if exists offline_time_reviews_fill_site_from_shift on public.offline_time_reviews;
create trigger offline_time_reviews_fill_site_from_shift before insert on public.offline_time_reviews
for each row execute function public.prosm_time_fill_site_from_shift();

revoke execute on function public.prosm_time_set_responsible_site_on_clock_in() from public, anon, authenticated;
revoke execute on function public.prosm_time_set_responsible_site_on_site_change() from public, anon, authenticated;
revoke execute on function public.prosm_time_fill_site_from_shift() from public, anon, authenticated;

-- SOS alerts already recorded without a site.
update sos_alerts a
set site_id = coalesce(ats.site_id, ats.responsible_site_id), site_name = coalesce(a.site_name, s.name)
from attendance_sessions ats
left join sites s on s.id = coalesce(ats.site_id, ats.responsible_site_id)
where a.site_id is null and ats.id = a.attendance_session_id;

drop policy if exists "members can view their own attendance events or org-wide with attendance.view" on public.attendance_events;
create policy "members can view their own attendance events or org-wide with attendance.view"
on public.attendance_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = attendance_events.session_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "break events visible to subject or attendance.view" on public.break_events;
create policy "break events visible to subject or attendance.view"
on public.break_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and exists (
                    select 1 from attendance_sessions s
                    where s.id = break_events.attendance_session_id
                    and (
                        coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids())
                        or public.current_prosm_time_user_role_key() = 'read_only'
                    )
                )
            )
        )
    )
);

drop policy if exists "camera evidence visible to subject or attendance.view" on public.camera_evidence;
create policy "camera evidence visible to subject or attendance.view"
on public.camera_evidence for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_events e
        join attendance_sessions s on s.id = e.session_id
        where e.id = camera_evidence.attendance_event_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "correction requests visible to subject or attendance.view" on public.correction_requests;
create policy "correction requests visible to subject or attendance.view"
on public.correction_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = correction_requests.attendance_session_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "members can view their own attendance sessions or org-wide with attendance.view" on public.attendance_sessions;
create policy "members can view their own attendance sessions or org-wide with attendance.view"
on public.attendance_sessions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(site_id, responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "presence sessions visible to subject or attendance.view" on public.presence_sessions;
create policy "presence sessions visible to subject or attendance.view"
on public.presence_sessions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(site_id, (select ats.responsible_site_id from attendance_sessions ats where ats.id = presence_sessions.attendance_session_id)) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "geofence exceptions visible to subject or attendance.view" on public.geofence_exceptions;
create policy "geofence exceptions visible to subject or attendance.view"
on public.geofence_exceptions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from attendance_sessions s
        where s.id = coalesce(
            (select e.session_id from attendance_events e where e.id = geofence_exceptions.attendance_event_id),
            (select ps.attendance_session_id from presence_sessions ps where ps.id = geofence_exceptions.presence_session_id)
        )
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "site change events visible to subject or attendance.view" on public.site_change_events;
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
                and (new_site_id = any(public.current_prosm_time_managed_site_ids()) or old_site_id = any(public.current_prosm_time_managed_site_ids()) or exists (select 1 from attendance_sessions s where s.id = site_change_events.attendance_session_id and s.responsible_site_id = any(public.current_prosm_time_managed_site_ids())))
            )
        )
    )
);

create or replace function public.trigger_prosm_time_shift_sos_alert(
    p_attendance_session_id uuid,
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
    v_session attendance_sessions%rowtype;
    v_presence_session_id uuid;
    v_alert_id uuid;
    v_caller_name text;
    v_site_name text;
    v_coworker record;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null or v_caller_org is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id;
    if v_session.id is null then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id or v_session.organization_id <> v_caller_org then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS SESSION';
    end if;

    if v_session.status <> 'clocked_in' then
        raise exception 'SOS REQUIRES AN ACTIVE SHIFT';
    end if;

    -- Keep the link to presence monitoring when the shift has it.
    select id into v_presence_session_id
    from presence_sessions
    where attendance_session_id = v_session.id and user_id = v_caller_id and status = 'active'
    limit 1;

    insert into sos_alerts (organization_id, user_id, presence_session_id, attendance_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, v_presence_session_id, v_session.id, p_latitude, p_longitude, p_accuracy_meters)
    returning id, site_name into v_alert_id, v_site_name;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active shift.',
        jsonb_build_object('attendanceSessionId', v_session.id, 'presenceSessionId', v_presence_session_id)
    );

    select full_name into v_caller_name from users where id = v_caller_id;

    -- Audit 4.5: the site's own managers plus the Owner (no site: the Owner).
    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, coalesce(v_session.site_id, v_session.responsible_site_id), 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
    );

    -- Same co-worker broadcast as the presence path (20260908170000).
    if v_session.site_id is not null then
        for v_coworker in
            select distinct ats.user_id as id
            from attendance_sessions ats
            join users u on u.id = ats.user_id
            where ats.site_id = v_session.site_id
              and ats.status = 'clocked_in'
              and ats.user_id <> v_caller_id
              and u.organization_id = v_caller_org
              -- already told above as the site's manager or the Owner
              and not u.is_owner
              and not exists (
                  select 1 from site_assignments sa
                  where sa.site_id = v_session.site_id and sa.user_id = u.id and sa.role_at_site = 'manager'
              )
        loop
            perform public.create_prosm_time_notification(
                v_caller_org, v_coworker.id, 'sos_alert', 'high', 'SOS/Emergency alert',
                v_caller_name || ' triggered an SOS/Emergency alert at ' || coalesce(v_site_name, 'your site') || '.',
                'sos_alerts', v_alert_id,
                jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
            );
        end loop;
    end if;

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SHIFT SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.trigger_prosm_time_sos_alert(
    p_presence_session_id uuid,
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
    v_session presence_sessions%rowtype;
    v_alert_id uuid;
    v_caller_name text;
    v_site_name text;
    v_coworker record;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'SOS REQUIRES AN ACTIVE PRESENCE SESSION';
    end if;

    insert into sos_alerts (organization_id, user_id, presence_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, p_presence_session_id, p_latitude, p_longitude, p_accuracy_meters)
    returning id into v_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active presence session.',
        jsonb_build_object('presenceSessionId', p_presence_session_id)
    );

    select full_name into v_caller_name from users where id = v_caller_id;

    -- Audit 4.5: the site's own managers plus the Owner (no site: the Owner).
    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, coalesce(v_session.site_id, (select ats.responsible_site_id from attendance_sessions ats where ats.id = v_session.attendance_session_id)), 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name)
    );

    if v_session.site_id is not null then
        select name into v_site_name from sites where id = v_session.site_id;

        for v_coworker in
            select distinct ats.user_id as id
            from attendance_sessions ats
            join users u on u.id = ats.user_id
            where ats.site_id = v_session.site_id
              and ats.status = 'clocked_in'
              and ats.user_id <> v_caller_id
              and u.organization_id = v_caller_org
              -- already told above as the site's manager or the Owner
              and not u.is_owner
              and not exists (
                  select 1 from site_assignments sa
                  where sa.site_id = v_session.site_id and sa.user_id = u.id and sa.role_at_site = 'manager'
              )
        loop
            perform public.create_prosm_time_notification(
                v_caller_org, v_coworker.id, 'sos_alert', 'high', 'SOS/Emergency alert',
                v_caller_name || ' triggered an SOS/Emergency alert at ' || coalesce(v_site_name, 'your site') || '.',
                'sos_alerts', v_alert_id,
                jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
            );
        end loop;
    end if;

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.handle_prosm_time_geofence_violation(
    p_organization_id uuid,
    p_user_id uuid,
    p_distance_meters double precision,
    p_attendance_event_id uuid default null,
    p_presence_session_id uuid default null,
    p_site_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_is_owner boolean;
    v_is_supervisor boolean;
    v_exception_id uuid;
    v_subject_name text;
    v_recipient record;
    v_open_breach uuid;
begin
    -- Owner 2026-10-18: still outside since an exception was opened for
    -- this time outside (for example a clock-out from where the shift's
    -- monitoring already found the person) - the same exception covers it.
    select ge.id into v_open_breach
    from presence_sessions ps
    join geofence_exceptions ge on ge.user_id = ps.user_id and ge.created_at >= ps.outside_since - interval '1 minute'
    where ps.user_id = p_user_id and ps.status = 'active' and ps.outside_since is not null
    order by ge.created_at
    limit 1;
    if v_open_breach is not null then
        return jsonb_build_object('exceptionCreated', false, 'exceptionId', v_open_breach);
    end if;

    -- Owner 2026-10-18: a shift with no site is followed by its nearest site's managers.
    if p_site_id is null then
        select ats.responsible_site_id into p_site_id
        from attendance_sessions ats
        where ats.id = coalesce(
            (select e.session_id from attendance_events e where e.id = p_attendance_event_id),
            (select ps.attendance_session_id from presence_sessions ps where ps.id = p_presence_session_id)
        );
    end if;

    select is_owner into v_is_owner from users where id = p_user_id;

    insert into geofence_exceptions (organization_id, user_id, attendance_event_id, presence_session_id, distance_meters, status)
    values (p_organization_id, p_user_id, p_attendance_event_id, p_presence_session_id, p_distance_meters, 'pending_reason')
    returning id into v_exception_id;

    select full_name into v_subject_name from users where id = p_user_id;

    perform public.create_prosm_time_notification(
        p_organization_id, p_user_id, 'out_of_zone_employee', 'normal',
        'You are outside your assigned work area',
        'Please explain why. Distance: ' || round(p_distance_meters::numeric) || ' m.',
        'geofence_exceptions', v_exception_id,
        jsonb_build_object('distanceMeters', round(p_distance_meters::numeric))
    );

    -- § fix, 2026-09-15 - the Owner has no one above them to escalate
    -- to (there is no concept of a second Owner/manager over an Owner
    -- in this schema) - they've already been notified themselves
    -- above, so there's nothing further to do here for that case.
    if coalesce(v_is_owner, false) then
        return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
    end if;

    v_is_supervisor := exists (
        select 1 from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join users u on u.role_id = rdp.role_id
            where u.id = p_user_id
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = p_user_id and upo.is_granted = false
        ) effective
        where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
    );

    if v_is_supervisor then
        for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                p_organization_id, v_recipient.id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
                v_subject_name || ' is outside the assigned area.', 'geofence_exceptions', v_exception_id,
                jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
            );
        end loop;
    else
        perform public.notify_prosm_time_site_managers_or_owner(
            p_organization_id, p_site_id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
            v_subject_name || ' is outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
        );
    end if;

    return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
exception
    when others then
        raise exception 'HANDLE PROSM TIME GEOFENCE VIOLATION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.list_prosm_time_visible_members()
returns table(id uuid, email text, full_name text, status text, is_owner boolean, is_active boolean, created_at timestamptz, role_key text, role_name text)
language sql
stable
security definer
set search_path = public
as $function$
    select u.id, u.email, u.full_name, u.status, u.is_owner, u.is_active, u.created_at, r.role_key, r.name as role_name
    from users u
    join roles r on r.id = u.role_id
    where u.organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or u.id = public.current_prosm_time_user_id()
        or (
            not u.is_owner
            and (
                exists (
                    select 1 from site_assignments sa
                    where sa.user_id = u.id
                    and sa.site_id = any(public.current_prosm_time_managed_site_ids())
                )
                -- Owner 2026-10-18: anyone working at a managed site right now -
                -- clocked in there without being assigned, or with no site and
                -- this as their nearest site - as if assigned, for that shift.
                or exists (
                    select 1 from attendance_sessions ats
                    where ats.user_id = u.id
                    and ats.status = 'clocked_in'
                    and coalesce(ats.site_id, ats.responsible_site_id) = any(public.current_prosm_time_managed_site_ids())
                )
            )
        )
    )
    order by u.created_at asc;
$function$;

commit;
