-- Owner 2026-10-20: an employee who isn't tied to any site "stays with the
-- Owner, or whoever the Owner authorises to act". A new permission,
-- people.unassigned, which the Owner can give to anyone (no role has it by
-- default): its holder acts on, and sees, employees with no site the way a
-- site manager does for their site's people - only for people ranked below
-- them. Items tied to a shift's site (an exception at the nearest site,
-- an SOS) keep following that site, as decided on 2026-10-18.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('people.unassigned', 'employees', 'ADMINISTER', 'Employees not tied to a site',
        'Approve, review and see the records of employees who are not assigned to any site.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'people.unassigned'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

create or replace function public.prosm_time_caller_has_authority_over(p_subject_user_id uuid, p_site_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from users u
        where u.id = p_subject_user_id
          and u.organization_id = public.current_prosm_time_organization_id()
          and (
              public.current_prosm_time_user_is_owner()
              or (
                  public.prosm_time_can_act_on_behalf_of(public.current_prosm_time_user_id(), u.id)
                  and case
                      when p_site_id is not null then p_site_id = any(public.current_prosm_time_managed_site_ids())
                      else exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
                          or (
                              not exists (select 1 from site_assignments sa where sa.user_id = u.id)
                              and public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'people.unassigned')
                          )
                  end
              )
          )
    );
$function$;

create or replace function public.prosm_time_caller_sees_person(p_subject_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from users u
        where u.id = p_subject_user_id
          and u.organization_id = public.current_prosm_time_organization_id()
          and (
              u.id = public.current_prosm_time_user_id()
              or public.current_prosm_time_user_is_owner()
              or public.current_prosm_time_user_role_key() = 'read_only'
              or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
              or exists (
                  select 1 from attendance_sessions s
                  where s.user_id = u.id and s.status = 'clocked_in'
                    and coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids())
              )
              or (
                  not exists (select 1 from site_assignments sa where sa.user_id = u.id)
                  and public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'people.unassigned')
              )
          )
    );
$function$;

commit;
