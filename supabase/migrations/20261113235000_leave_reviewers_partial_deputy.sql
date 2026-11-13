-- 20261113170000 left out a deputy given chosen permissions that include leave approval (the owner's partial
-- authority); they decide leave for the owner and are listed again, as deputies.
-- Rollback: re-run prosm_time_leave_reviewers_for from 20261113170000.

begin;

create or replace function public.prosm_time_leave_reviewers_for(p_user_id uuid)
returns table (id uuid, full_name text, is_owner boolean, role_key text, manages_site boolean, is_deputy boolean)
language sql
stable
security definer
set search_path = public
as $$
    select u.id, u.full_name, u.is_owner, r.role_key,
           exists (select 1 from site_assignments ms join site_assignments ss on ss.site_id = ms.site_id
                   where ms.user_id = u.id and ms.role_at_site = 'manager' and ss.user_id = p_user_id),
           public.prosm_time_is_owner_delegate(u.id) or 'leave.approve' = any(public.prosm_time_delegated_permissions(u.id))
    from users u
    left join roles r on r.id = u.role_id
    where u.organization_id = (select organization_id from users where id = p_user_id)
      and u.is_active and u.id <> p_user_id
      and (
          u.is_owner
          or public.prosm_time_is_owner_delegate(u.id)
          or 'leave.approve' = any(public.prosm_time_delegated_permissions(u.id))
          or (
              public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_user_has_authority_over(u.id, p_user_id)
          )
      );
$$;
revoke all on function public.prosm_time_leave_reviewers_for(uuid) from public, anon, authenticated;

commit;
