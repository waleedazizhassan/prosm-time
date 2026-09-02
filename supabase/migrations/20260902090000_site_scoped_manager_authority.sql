-- PROSM Time - live UX review, user-directed, 5 confirmed real gaps for
-- a Manager (site admin, "amira adel") reported together, all the same
-- root cause: 'sites.manage'/'attendance.view'/on-behalf permissions
-- were granted org-wide with no scoping to the SPECIFIC site(s) a
-- Manager actually manages. This is the deferred item flagged in
-- migration 20260902070000's own header comment ("no site-to-manager
-- assignment data model... a genuine new feature") - the data model
-- already exists (site_assignments.role_at_site = 'manager', built in
-- WP-05), it was just never plumbed into RLS/RPC authorization. This
-- migration does that plumbing:
--
-- 1. People list showed every org member including the Owner -> now a
--    dedicated RPC scoped to (Owner sees all) / (self) / (anyone
--    assigned to a site this caller manages, Owner excluded).
-- 2. Sites list + "Add Site" showed/allowed every site -> sites SELECT
--    RLS now requires a real site_assignments row; site CREATION is
--    now Owner-only (a Manager no longer creates new sites, only
--    manages the ones already assigned to them).
-- 3. Manager Console attendance showed every session including the
--    Owner's -> attendance_sessions/attendance_events/camera_evidence/
--    correction_requests/geofence_exceptions/presence_sessions SELECT
--    RLS all now require the session's own site to be one of the
--    caller's managed sites (Owner keeps unscoped visibility).
-- 4. On-behalf Clock In/Out let a Manager act at any site -> both RPCs
--    now require the site (clock-in: p_site_id; clock-out: the open
--    session's own site_id) to be one of the caller's managed sites.
-- 5. update/remove site assignment now carry the same managed-site
--    scoping as set_prosm_time_site_assignment already got in
--    20260902070000, and update_prosm_time_site the same for editing
--    a site's own settings.

begin;

-- ============================================================
-- 0. current_prosm_time_managed_site_ids() - the one new helper every
--    scoped policy/RPC below reuses (DRY, matches this codebase's own
--    current_prosm_time_*() convention).
-- ============================================================

create or replace function public.current_prosm_time_managed_site_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(array_agg(site_id), array[]::uuid[])
    from site_assignments
    where user_id = public.current_prosm_time_user_id()
    and role_at_site = 'manager';
$function$;

revoke all on function public.current_prosm_time_managed_site_ids() from public, anon;
grant execute on function public.current_prosm_time_managed_site_ids() to authenticated;

-- ============================================================
-- 1. Visible-members RPC (People list) - replaces the raw, unscoped
--    `users` select EmployeeRepository.listOrganizationMembers() used.
--    Deliberately a dedicated RPC rather than tightening `users` table
--    RLS itself - that table's own broad "same organization" policy is
--    relied on by many other flows (self-profile reads, name lookups
--    embedded via FKs across this schema) that have nothing to do with
--    the People list and must keep working exactly as they do today.
-- ============================================================

create or replace function public.list_prosm_time_visible_members()
returns table (
    id uuid,
    email text,
    full_name text,
    status text,
    is_owner boolean,
    created_at timestamptz,
    role_key text,
    role_name text
)
language sql
stable
security definer
set search_path = public
as $function$
    select u.id, u.email, u.full_name, u.status, u.is_owner, u.created_at, r.role_key, r.name as role_name
    from users u
    join roles r on r.id = u.role_id
    where u.organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or u.id = public.current_prosm_time_user_id()
        or (
            not u.is_owner
            and exists (
                select 1 from site_assignments sa
                where sa.user_id = u.id
                and sa.site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
    order by u.created_at asc;
$function$;

revoke all on function public.list_prosm_time_visible_members() from public, anon;
grant execute on function public.list_prosm_time_visible_members() to authenticated;

-- ============================================================
-- 2. Sites - real per-site assignment required to see a site at all
--    (Owner keeps unscoped visibility). Site creation is Owner-only;
--    editing an existing site's settings stays available to a Manager,
--    but only for a site they actually manage.
-- ============================================================

drop policy if exists "members can view sites in own organization" on public.sites;
create policy "members can view sites in own organization"
on public.sites for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or exists (select 1 from site_assignments sa where sa.site_id = sites.id and sa.user_id = public.current_prosm_time_user_id())
    )
);

create or replace function public.create_prosm_time_site(
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
    p_grace_tolerance_minutes integer default 5
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

    insert into sites (
        organization_id, name, display_address, latitude, longitude,
        allowed_radius_meters, gps_accuracy_tolerance_meters, timezone,
        attendance_allowed, geofence_required, camera_required,
        kiosk_mode, environmental_tag_enabled, grace_tolerance_minutes
    ) values (
        v_caller_org, trim(p_name), p_display_address, p_latitude, p_longitude,
        p_allowed_radius_meters, p_gps_accuracy_tolerance_meters, p_timezone,
        p_attendance_allowed, p_geofence_required, p_camera_required,
        p_kiosk_mode, p_environmental_tag_enabled, p_grace_tolerance_minutes
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

create or replace function public.update_prosm_time_site(
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
    p_is_active boolean default null
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

-- ============================================================
-- 3. Site assignment RPCs - the same "must actually manage this site"
--    scoping added to update/remove (set_ already got its own
--    who-can-be-assigned/what-role scoping in 20260902070000; this
--    adds the WHICH SITE half that migration didn't cover).
-- ============================================================

create or replace function public.set_prosm_time_site_assignment(
    p_site_id uuid,
    p_user_id uuid,
    p_role_at_site text default 'member'
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
    v_target_role_key text;
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

    if p_role_at_site not in ('member', 'manager') then
        raise exception 'INVALID ROLE AT SITE';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        select r.role_key into v_target_role_key from roles r where r.id = v_target.role_id;

        if v_target.is_owner or v_target_role_key <> 'employee' then
            raise exception 'ONLY THE ORGANIZATION OWNER MAY ASSIGN NON-EMPLOYEE MEMBERS TO A SITE';
        end if;

        if p_role_at_site = 'manager' then
            raise exception 'ONLY THE ORGANIZATION OWNER MAY GRANT SITE MANAGER';
        end if;
    end if;

    insert into site_assignments (site_id, user_id, role_at_site, assigned_by)
    values (p_site_id, p_user_id, p_role_at_site, v_caller_id)
    on conflict (site_id, user_id)
    do update set role_at_site = excluded.role_at_site, assigned_by = excluded.assigned_by
    returning id into v_assignment_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, p_user_id, 'SITE_ASSIGNMENT_SET', 'site_assignments', v_assignment_id,
        v_target.full_name || ' assigned to site ' || v_site.name || ' as ' || p_role_at_site || '.'
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'SET PROSM TIME SITE ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.remove_prosm_time_site_assignment(
    p_site_id uuid,
    p_user_id uuid
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

    delete from site_assignments where site_id = p_site_id and user_id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, p_user_id, 'SITE_ASSIGNMENT_REMOVED', 'site_assignments', p_site_id,
        v_target.full_name || ' removed from site ' || v_site.name || '.'
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REMOVE PROSM TIME SITE ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- 4. Attendance-family SELECT RLS - the same "attendance.view holders
--    see everything" pattern, repeated across 6 tables, all get the
--    same site-scoping added to the org-wide branch. Owner keeps
--    unscoped visibility everywhere. attendance_events/camera_evidence/
--    correction_requests/geofence_exceptions reach site_id via a join
--    (they don't carry it directly); attendance_sessions/
--    presence_sessions have their own site_id column.
-- ============================================================

drop policy if exists "members can view their own attendance sessions or org-wide with" on public.attendance_sessions;
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
                and site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
);

drop policy if exists "members can view their own attendance events or org-wide with a" on public.attendance_events;
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
                and s.site_id = any(public.current_prosm_time_managed_site_ids())
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
                and s.site_id = any(public.current_prosm_time_managed_site_ids())
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
                and s.site_id = any(public.current_prosm_time_managed_site_ids())
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
        select 1 from attendance_events e
        join attendance_sessions s on s.id = e.session_id
        where e.id = geofence_exceptions.attendance_event_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and s.site_id = any(public.current_prosm_time_managed_site_ids())
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
                and site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
);

-- ============================================================
-- 5. On-behalf Clock In/Out - a Manager's on-behalf authority is now
--    scoped to sites they actually manage, not "any site the subject
--    happens to be assigned to". A no-site (site-optional clock-in)
--    open session has nothing for a non-owner to be scoped against, so
--    on-behalf clock-out of one is Owner-only.
-- ============================================================

create or replace function public.admin_clock_in_prosm_time_attendance(
    p_subject_user_id uuid,
    p_site_id uuid,
    p_reason text,
    p_project_id uuid default null,
    p_idempotency_key text default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_device_info text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_idempotency_key text;
    v_audit_log_id uuid;
    v_action_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_in_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_IN_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if not public.current_prosm_time_user_is_owner() and not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-in-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = p_subject_user_id) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = p_subject_user_id) then
            raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'THIS EMPLOYEE IS ALREADY CLOCKED IN';
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, p_subject_user_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_session_id, p_subject_user_id, 'clock_in', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_IN_ON_BEHALF', 'attendance_sessions', v_session_id,
        v_subject.full_name || ' clocked in by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('siteId', p_site_id, 'projectId', p_project_id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_in', v_session_id, v_event_id,
        p_reason, 'not_clocked_in', 'clocked_in', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.admin_clock_out_prosm_time_attendance(
    p_subject_user_id uuid,
    p_reason text,
    p_idempotency_key text default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_device_info text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_event_id uuid;
    v_idempotency_key text;
    v_audit_log_id uuid;
    v_action_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-out-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'THIS EMPLOYEE IS NOT CURRENTLY CLOCKED IN';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        if v_open_session.site_id is null or not (v_open_session.site_id = any(public.current_prosm_time_managed_site_ids())) then
            raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
        end if;
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_open_session.id, p_subject_user_id, 'clock_out', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_OUT_ON_BEHALF', 'attendance_sessions', v_open_session.id,
        v_subject.full_name || ' clocked out by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('sessionId', v_open_session.id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_out', v_open_session.id, v_event_id,
        p_reason, 'clocked_in', 'clocked_out', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

commit;
