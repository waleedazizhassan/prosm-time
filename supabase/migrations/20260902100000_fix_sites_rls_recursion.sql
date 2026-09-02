-- PROSM Time - fix for a real bug in the immediately preceding
-- migration (20260902090000), caught live during verification: the new
-- `sites` SELECT policy queried `site_assignments` directly inside its
-- USING clause, but `site_assignments`'s own SELECT policy queries
-- `sites` right back ("site_id in (select id from sites where
-- organization_id = ...)") - a direct circular RLS reference, which
-- Postgres correctly refuses to evaluate ("infinite recursion detected
-- in policy for relation sites").
--
-- Every other current_prosm_time_*() helper in this schema already
-- avoids this: they are SECURITY DEFINER functions, which run with
-- their owner's privileges - not the calling authenticated role's - so
-- the tables THEY query never re-trigger RLS the way a raw subquery
-- inline in a policy does. current_prosm_time_managed_site_ids() (the
-- previous migration's own new helper) already queries site_assignments
-- this same safe way; this adds the sibling helper for "any assignment,
-- not just role_at_site='manager'" and routes the sites policy through
-- it instead of a raw EXISTS subquery.

begin;

create or replace function public.current_prosm_time_assigned_site_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(array_agg(site_id), array[]::uuid[])
    from site_assignments
    where user_id = public.current_prosm_time_user_id();
$function$;

revoke all on function public.current_prosm_time_assigned_site_ids() from public, anon;
grant execute on function public.current_prosm_time_assigned_site_ids() to authenticated;

drop policy if exists "members can view sites in own organization" on public.sites;
create policy "members can view sites in own organization"
on public.sites for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or id = any(public.current_prosm_time_assigned_site_ids())
    )
);

commit;
