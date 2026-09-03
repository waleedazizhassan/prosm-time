-- PROSM Time - surface the new users.is_active flag (20260903150000)
-- through list_prosm_time_visible_members() so the People list can
-- show a deactivated employee's real status. Return type changes -
-- drop then recreate per this codebase's own convention.

begin;

drop function if exists public.list_prosm_time_visible_members();

create function public.list_prosm_time_visible_members()
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
            and exists (
                select 1 from site_assignments sa
                where sa.user_id = u.id
                and sa.site_id = any(public.current_prosm_time_managed_site_ids())
            )
        )
    )
    order by u.created_at asc;
$function$;

grant execute on function public.list_prosm_time_visible_members() to authenticated;

commit;
