-- Owner 2026-11-13: "'Send the request to' lists only the owner. It should list the managers of my site, the
-- owner, and anyone who may grant leave - each with what they are, so I know who I send it to."
-- The list now holds exactly the people whose approval the server accepts (review_prosm_time_leave): the owner,
-- the owner's deputies (full, or chosen including leave approval), and whoever holds leave approval with authority
-- over the person - a higher rank managing one of the person's sites, or, for someone without a site, one who
-- holds people.unassigned. Nobody is listed who could not decide the request. Each comes with their role and
-- whether they manage the person's site. Rollback: restore prosm_time_leave_reviewers_for and
-- list_prosm_time_leave_reviewers from 20261027120000 / 20261108100000; drop prosm_time_user_has_authority_over.

begin;

-- prosm_time_caller_has_authority_over, for any two people (no site given)
create or replace function public.prosm_time_user_has_authority_over(p_actor uuid, p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from users s join users a on a.id = p_actor
        where s.id = p_subject and s.organization_id = a.organization_id and a.is_active and s.id <> a.id
          and (
              a.is_owner
              or public.prosm_time_is_owner_delegate(a.id)
              or (
                  public.prosm_time_can_act_on_behalf_of(a.id, s.id)
                  and (
                      exists (select 1 from site_assignments ss join site_assignments ms on ms.site_id = ss.site_id
                              where ss.user_id = s.id and ms.user_id = a.id and ms.role_at_site = 'manager')
                      or (
                          not exists (select 1 from site_assignments ss where ss.user_id = s.id)
                          and public.prosm_time_user_has_permission_internal(a.id, 'people.unassigned')
                      )
                  )
              )
          )
    );
$$;
revoke all on function public.prosm_time_user_has_authority_over(uuid, uuid) from public, anon, authenticated;

drop function if exists public.prosm_time_leave_reviewers_for(uuid);
create function public.prosm_time_leave_reviewers_for(p_user_id uuid)
returns table (id uuid, full_name text, is_owner boolean, role_key text, manages_site boolean, is_deputy boolean)
language sql
stable
security definer
set search_path = public
as $$
    select u.id, u.full_name, u.is_owner, r.role_key,
           exists (select 1 from site_assignments ms join site_assignments ss on ss.site_id = ms.site_id
                   where ms.user_id = u.id and ms.role_at_site = 'manager' and ss.user_id = p_user_id),
           public.prosm_time_is_owner_delegate(u.id)
    from users u
    left join roles r on r.id = u.role_id
    where u.organization_id = (select organization_id from users where id = p_user_id)
      and u.is_active and u.id <> p_user_id
      and (
          u.is_owner
          or public.prosm_time_is_owner_delegate(u.id)
          or (
              public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_user_has_authority_over(u.id, p_user_id)
          )
      );
$$;
revoke all on function public.prosm_time_leave_reviewers_for(uuid) from public, anon, authenticated;

create or replace function public.list_prosm_time_leave_reviewers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.full_name, 'isOwner', r.is_owner, 'role', r.role_key,
                                            'managesMySite', r.manages_site, 'isDeputy', r.is_deputy)
                         order by r.is_owner desc, r.manages_site desc, r.full_name)
        from public.prosm_time_leave_reviewers_for(v_caller) r
    ), '[]'::jsonb);
end;
$function$;

commit;
