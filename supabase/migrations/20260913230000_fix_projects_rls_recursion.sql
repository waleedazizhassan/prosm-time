-- PROSM Time - real infinite recursion (42P17) hit live while
-- verifying 20260913210000's own projects/project_assignments fix,
-- caught before it ever left this session (org has 0 real project
-- rows today, so this would have silently broken the moment the first
-- one was created, for any non-superuser session). Same exact A<->B
-- cycle shape as the sites<->site_assignments recursion
-- (20260909111000) and the users<->site_assignments recursion
-- (20260911180000): projects' new policy queried project_assignments
-- directly, project_assignments' new policy queried projects directly
-- - each re-triggers the other's RLS forever.
--
-- Fixed the same way those were: every cross-table check reads
-- through a SECURITY DEFINER helper function instead of an inline
-- subquery in the policy body, so the read happens under the
-- function's own elevated privilege (bypassing RLS entirely) and
-- never re-enters the other table's row-level security.

begin;

create or replace function public.current_prosm_time_caller_assigned_to_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from project_assignments pa
        where pa.project_id = p_project_id
        and pa.user_id = public.current_prosm_time_user_id()
    );
$function$;

revoke all on function public.current_prosm_time_caller_assigned_to_project(uuid) from public, anon;
grant execute on function public.current_prosm_time_caller_assigned_to_project(uuid) to authenticated;

create or replace function public.current_prosm_time_caller_manages_project_site(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from projects p
        where p.id = p_project_id
        and p.site_id = any(public.current_prosm_time_managed_site_ids())
    );
$function$;

revoke all on function public.current_prosm_time_caller_manages_project_site(uuid) from public, anon;
grant execute on function public.current_prosm_time_caller_manages_project_site(uuid) to authenticated;

drop policy if exists "members can view projects in own organization" on public.projects;
create policy "members can view projects in own organization"
on public.projects for select to authenticated
using (
    site_id in (select id from sites where organization_id = public.current_prosm_time_organization_id())
    and (
        public.current_prosm_time_user_is_owner()
        or site_id = any(public.current_prosm_time_managed_site_ids())
        or public.current_prosm_time_caller_assigned_to_project(id)
    )
);

drop policy if exists "members can view project assignments in own organization" on public.project_assignments;
create policy "members can view project assignments in own organization"
on public.project_assignments for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or public.current_prosm_time_caller_manages_project_site(project_id)
);

commit;
