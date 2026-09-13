-- PROSM Time - real governance/permissions audit (user-directed,
-- 2026-09-13, run against 3 real accounts: Owner admin@prosm.net,
-- Manager eaya4340@gmail.com/"Uu" assigned to site العجمي, Employee
-- waleedaziz144@yahoo.com/"Lido" with no site assignment). 4 real,
-- distinct findings, all fixed here.
--
-- 1 & 2. A real_only-role regression, self-inflicted twice: the
-- 'read_only' role ("pure org-wide reporting viewer") got a deliberate,
-- explicit exception in 20260909110000 on 6 attendance-family tables
-- (sites, attendance_sessions/events, camera_evidence,
-- correction_requests, geofence_exceptions, presence_sessions) so its
-- own zero site_assignments never collapses its visibility to nothing.
-- Two LATER changes never carried that same exception forward:
--   - current_prosm_time_caller_sees_users_attendance() (20260911180000,
--     the `users` table's own real RLS fix) - a read_only viewer could
--     already see attendance_sessions org-wide, but not the matching
--     employee NAME via `users`, since this helper only checks managed_
--     site_ids(). Every report/screen resolving an employee's name off
--     an attendance row (ManagerRepository's `users(full_name)` embeds)
--     would show blank names for a read_only account.
--   - break_events' own SELECT policy (20260911200000, written 2 days
--     ago) - same gap, same fix, never cross-referenced against the
--     existing read_only pattern at the time.
--
-- 3. projects/project_assignments' SELECT policies were NEVER touched
-- since their original creation (20260831140000) - still flat
-- "same organization" visibility for every authenticated member,
-- unlike every other site-scoped domain table in this schema. A
-- Manager who manages only one site (or a plain Employee) could see
-- every project and every project assignment at every OTHER site too.
--
-- 4. create_prosm_time_project / update_prosm_time_project /
-- set_prosm_time_project_assignment / remove_prosm_time_project_
-- assignment all check only the flat 'projects.manage' permission,
-- with NO site-scoping check at all - a Manager who manages only one
-- site could create, edit, deactivate, or reassign projects at ANY
-- other site in the organization. The exact same authority-boundary
-- gap already closed for sites/shifts/on-behalf-attendance elsewhere,
-- just never applied here since these 4 RPCs were never revisited
-- since 20260831140000.

begin;

-- ---------- Finding 1: users table's own attendance-based visibility ----------

create or replace function public.current_prosm_time_caller_sees_users_attendance(p_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from attendance_sessions s
        where s.user_id = p_target_user_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            s.site_id = any(public.current_prosm_time_managed_site_ids())
            or public.current_prosm_time_user_role_key() = 'read_only'
        )
    );
$function$;

-- ---------- Finding 2: break_events ----------

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
                        s.site_id = any(public.current_prosm_time_managed_site_ids())
                        or public.current_prosm_time_user_role_key() = 'read_only'
                    )
                )
            )
        )
    )
);

-- ---------- Finding 3: projects / project_assignments visibility ----------

drop policy if exists "members can view projects in own organization" on public.projects;
create policy "members can view projects in own organization"
on public.projects for select to authenticated
using (
    site_id in (select id from sites where organization_id = public.current_prosm_time_organization_id())
    and (
        public.current_prosm_time_user_is_owner()
        or site_id = any(public.current_prosm_time_managed_site_ids())
        or exists (
            select 1 from project_assignments pa
            where pa.project_id = projects.id and pa.user_id = public.current_prosm_time_user_id()
        )
    )
);

drop policy if exists "members can view project assignments in own organization" on public.project_assignments;
create policy "members can view project assignments in own organization"
on public.project_assignments for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from projects p
        join sites s on s.id = p.site_id
        where p.id = project_assignments.project_id
        and s.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or s.id = any(public.current_prosm_time_managed_site_ids())
        )
    )
);

-- ---------- Finding 4: project write RPCs ----------

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

    -- § real bug fix, 2026-09-13 - a Manager could create a project at
    -- any site in the organization, not just one they actually manage.
    if not public.current_prosm_time_user_is_owner() and not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    insert into projects (site_id, name, code, description)
    values (p_site_id, trim(p_name), p_code, p_description)
    returning id into v_project_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (
        v_caller_org, v_caller_id, 'PROJECT_CREATED', 'projects', v_project_id,
        'Project ' || trim(p_name) || ' created under site ' || v_site.name || '.',
        jsonb_build_object('name', trim(p_name), 'siteId', p_site_id, 'code', p_code)
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

    -- § real bug fix, 2026-09-13 - see this migration's own header.
    if not public.current_prosm_time_user_is_owner() and not (v_project.site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
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

    -- § real bug fix, 2026-09-13 - see this migration's own header.
    if not public.current_prosm_time_user_is_owner() and not (v_project.site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
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

    -- § real bug fix, 2026-09-13 - see this migration's own header.
    if not public.current_prosm_time_user_is_owner() and not (v_project.site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
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

commit;
