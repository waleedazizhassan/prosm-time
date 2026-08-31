-- PROSM Time Implementation Master File V3.0, WP-05 (§13 "Sites &
-- Projects", §13.1 "Kiosk Mode", §14 "Project Selection", §34 schema
-- list). A worksite is a first-class operational entity with a
-- display address (informational only) plus GPS coordinates and a
-- radius that are the real source of truth for geofence validation
-- (enforced server-side starting WP-09 - this package only creates
-- the entities and their policy configuration). Site -> Project ->
-- Employee -> Assignment -> Attendance event is the relationship the
-- rest of the product (WP-06 onward) is built on.

-- ============================================================
-- 1. sites
-- ============================================================

create table public.sites (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    name text not null,
    display_address text,

    -- §13: "the written address is informational. GPS coordinates and
    -- configured radius are the source of truth for geofence
    -- validation."
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    allowed_radius_meters integer not null default 100 check (allowed_radius_meters > 0),

    -- §13: "GPS accuracy/tolerance policy - configurable per site, not
    -- just globally." §15: added to the allowed radius when validating
    -- a captured sample.
    gps_accuracy_tolerance_meters integer not null default 50 check (gps_accuracy_tolerance_meters >= 0),

    -- §13: "Time zone (site-local display; storage remains UTC)."
    timezone text not null default 'UTC',

    is_active boolean not null default true,

    -- §13 site policy toggles.
    attendance_allowed boolean not null default true,
    geofence_required boolean not null default true,
    camera_required boolean not null default false,
    environmental_tag_enabled boolean not null default false,

    -- §13.1 Kiosk Mode - per-site device policy.
    kiosk_mode text not null default 'personal_device_only'
        check (kiosk_mode in ('personal_device_only', 'kiosk_only', 'both_allowed')),

    -- §15: "a configurable, per-site grace/accuracy policy to reduce
    -- false alarms from GPS drift" - grace period applied to lateness/
    -- exception timing, distinct from the GPS accuracy tolerance above.
    grace_tolerance_minutes integer not null default 5 check (grace_tolerance_minutes >= 0),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (organization_id, name)
);

create index sites_organization_id_idx on public.sites(organization_id);

-- ============================================================
-- 2. site_assignments - "Assigned employees, assigned managers" (§13).
--    No organization_id column, same pattern as WP-04's device_bindings
--    - RLS scopes through the site's own organization_id.
-- ============================================================

create table public.site_assignments (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references public.sites(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    role_at_site text not null default 'member' check (role_at_site in ('member', 'manager')),
    assigned_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (site_id, user_id)
);

create index site_assignments_site_id_idx on public.site_assignments(site_id);
create index site_assignments_user_id_idx on public.site_assignments(user_id);

-- ============================================================
-- 3. projects - §14: "Site -> Project -> Employee -> Assignment ->
--    Attendance event." A project always belongs to exactly one site;
--    "optional project association" in §13 means a site may have zero
--    projects, not that a project can be siteless.
-- ============================================================

create table public.projects (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references public.sites(id) on delete cascade,

    name text not null,
    code text,
    description text,
    is_active boolean not null default true,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (site_id, name)
);

create index projects_site_id_idx on public.projects(site_id);

-- ============================================================
-- 4. project_assignments - §14: "Employees must not be able to select
--    projects to which they are not assigned." This table is the
--    authorization source for that rule; WP-06's Clock In flow reads
--    it to filter the project picker.
-- ============================================================

create table public.project_assignments (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    assigned_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (project_id, user_id)
);

create index project_assignments_project_id_idx on public.project_assignments(project_id);
create index project_assignments_user_id_idx on public.project_assignments(user_id);

-- ============================================================
-- 5. RLS - same shape as WP-03/WP-04: broad organization-scoped SELECT
--    for every authenticated member; every write goes through a
--    SECURITY DEFINER RPC below that re-checks 'sites.manage' /
--    'projects.manage' (or Owner) itself, exactly like WP-04's
--    permission-override RPCs re-check 'permissions.assign'.
-- ============================================================

alter table public.sites enable row level security;
alter table public.site_assignments enable row level security;
alter table public.projects enable row level security;
alter table public.project_assignments enable row level security;

revoke all on public.sites from anon, authenticated;
revoke all on public.site_assignments from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_assignments from anon, authenticated;

grant select on public.sites to authenticated;
grant select on public.site_assignments to authenticated;
grant select on public.projects to authenticated;
grant select on public.project_assignments to authenticated;

create policy "members can view sites in own organization"
on public.sites for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

create policy "members can view site assignments in own organization"
on public.site_assignments for select to authenticated
using (site_id in (select id from sites where organization_id = public.current_prosm_time_organization_id()));

create policy "members can view projects in own organization"
on public.projects for select to authenticated
using (site_id in (select id from sites where organization_id = public.current_prosm_time_organization_id()));

create policy "members can view project assignments in own organization"
on public.project_assignments for select to authenticated
using (
    project_id in (
        select p.id from projects p
        join sites s on s.id = p.site_id
        where s.organization_id = public.current_prosm_time_organization_id()
    )
);

-- ============================================================
-- 6. Site CRUD RPCs - gated on 'sites.manage' (or Owner).
-- ============================================================

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

    if not (
        public.current_prosm_time_user_is_owner()
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED';
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
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    update sites set
        name = coalesce(nullif(trim(p_name), ''), name),
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

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state)
    values (
        v_caller_org, v_caller_id, 'SITE_UPDATED', 'sites', p_site_id,
        'Site ' || v_site.name || ' updated.', to_jsonb(v_site)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'UPDATE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer) to authenticated;
grant execute on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean) to authenticated;

-- ============================================================
-- 7. Site assignment RPCs - gated on 'sites.manage' (or Owner).
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
    v_assignment_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED';
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
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED';
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

grant execute on function public.set_prosm_time_site_assignment(uuid, uuid, text) to authenticated;
grant execute on function public.remove_prosm_time_site_assignment(uuid, uuid) to authenticated;

-- ============================================================
-- 8. Project CRUD RPCs - gated on 'projects.manage' (or Owner).
-- ============================================================

create or replace function public.create_prosm_time_project(
    p_site_id uuid,
    p_name text,
    p_code text default null,
    p_description text default null
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
    v_project_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'projects.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PROJECTS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'PROJECT NAME IS REQUIRED';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    insert into projects (site_id, name, code, description)
    values (p_site_id, trim(p_name), p_code, p_description)
    returning id into v_project_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, 'PROJECT_CREATED', 'projects', v_project_id,
        'Project ' || trim(p_name) || ' created under site ' || v_site.name || '.'
    );

    return jsonb_build_object('success', true, 'projectId', v_project_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME PROJECT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.update_prosm_time_project(
    p_project_id uuid,
    p_name text default null,
    p_code text default null,
    p_description text default null,
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
    v_project projects%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'projects.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PROJECTS.MANAGE AUTHORITY REQUIRED';
    end if;

    select p.* into v_project from projects p
    join sites s on s.id = p.site_id
    where p.id = p_project_id and s.organization_id = v_caller_org;
    if v_project.id is null then
        raise exception 'PROJECT NOT FOUND';
    end if;

    update projects set
        name = coalesce(nullif(trim(p_name), ''), name),
        code = coalesce(p_code, code),
        description = coalesce(p_description, description),
        is_active = coalesce(p_is_active, is_active),
        updated_at = now()
    where id = p_project_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state)
    values (
        v_caller_org, v_caller_id, 'PROJECT_UPDATED', 'projects', p_project_id,
        'Project ' || v_project.name || ' updated.', to_jsonb(v_project)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'UPDATE PROSM TIME PROJECT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.create_prosm_time_project(uuid, text, text, text) to authenticated;
grant execute on function public.update_prosm_time_project(uuid, text, text, text, boolean) to authenticated;

-- ============================================================
-- 9. Project assignment RPCs - §14's authorization source. Gated on
--    'projects.manage' (or Owner).
-- ============================================================

create or replace function public.set_prosm_time_project_assignment(
    p_project_id uuid,
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
    v_project projects%rowtype;
    v_site_name text;
    v_target users%rowtype;
    v_assignment_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'projects.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PROJECTS.MANAGE AUTHORITY REQUIRED';
    end if;

    select p.* into v_project from projects p
    join sites s on s.id = p.site_id
    where p.id = p_project_id and s.organization_id = v_caller_org;
    if v_project.id is null then
        raise exception 'PROJECT NOT FOUND';
    end if;

    select s.name into v_site_name from sites s where s.id = v_project.site_id;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    insert into project_assignments (project_id, user_id, assigned_by)
    values (p_project_id, p_user_id, v_caller_id)
    on conflict (project_id, user_id) do nothing
    returning id into v_assignment_id;

    if v_assignment_id is null then
        select id into v_assignment_id from project_assignments where project_id = p_project_id and user_id = p_user_id;
    else
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
        values (
            v_caller_org, v_caller_id, p_user_id, 'PROJECT_ASSIGNMENT_SET', 'project_assignments', v_assignment_id,
            v_target.full_name || ' assigned to project ' || v_project.name || '.'
        );
    end if;

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'SET PROSM TIME PROJECT ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.remove_prosm_time_project_assignment(
    p_project_id uuid,
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
    v_project projects%rowtype;
    v_target users%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'projects.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PROJECTS.MANAGE AUTHORITY REQUIRED';
    end if;

    select p.* into v_project from projects p
    join sites s on s.id = p.site_id
    where p.id = p_project_id and s.organization_id = v_caller_org;
    if v_project.id is null then
        raise exception 'PROJECT NOT FOUND';
    end if;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    delete from project_assignments where project_id = p_project_id and user_id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, p_user_id, 'PROJECT_ASSIGNMENT_REMOVED', 'project_assignments', p_project_id,
        v_target.full_name || ' removed from project ' || v_project.name || '.'
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REMOVE PROSM TIME PROJECT ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.set_prosm_time_project_assignment(uuid, uuid) to authenticated;
grant execute on function public.remove_prosm_time_project_assignment(uuid, uuid) to authenticated;
