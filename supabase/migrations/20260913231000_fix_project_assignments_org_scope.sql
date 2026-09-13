-- PROSM Time - real bug caught before it ever left this session,
-- reviewing my own immediately-preceding recursion fix
-- (20260913230000): project_assignments' new policy's Owner branch
-- was `... or public.current_prosm_time_user_is_owner() or ...` with
-- NO organization check anywhere in the policy at all -
-- current_prosm_time_user_is_owner() is a flat `select is_owner from
-- users where auth_user_id = auth.uid()`, completely unscoped to any
-- target row's organization_id. Any Owner (of ANY organization) would
-- have matched this branch for EVERY project_assignments row in the
-- entire database, across every tenant - a real cross-tenant leak.
-- project_assignments has no organization_id or site_id column of its
-- own to filter through directly (unlike projects, whose policy
-- already correctly AND-gates every branch behind a real org check);
-- this adds the missing equivalent via one more SECURITY DEFINER
-- helper, same non-recursive shape as the other two added moments ago.
--
-- The real org's own project_assignments count is 0 today (confirmed
-- live while testing 20260913210000) - no real cross-tenant data was
-- ever actually exposed by this.

begin;

create or replace function public.current_prosm_time_project_belongs_to_caller_org(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from projects p
        join sites s on s.id = p.site_id
        where p.id = p_project_id
        and s.organization_id = public.current_prosm_time_organization_id()
    );
$function$;

revoke all on function public.current_prosm_time_project_belongs_to_caller_org(uuid) from public, anon;
grant execute on function public.current_prosm_time_project_belongs_to_caller_org(uuid) to authenticated;

drop policy if exists "members can view project assignments in own organization" on public.project_assignments;
create policy "members can view project assignments in own organization"
on public.project_assignments for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        public.current_prosm_time_project_belongs_to_caller_org(project_id)
        and (
            public.current_prosm_time_user_is_owner()
            or public.current_prosm_time_caller_manages_project_site(project_id)
        )
    )
);

commit;
