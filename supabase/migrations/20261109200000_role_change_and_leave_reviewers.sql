-- 2026-11-09 spec B-01 and B-04.
-- B-01: a person's role could only be set when they were invited; there was no way to change it.
--   change_prosm_time_user_role: the real owner, or whoever holds permissions.assign for a role below
--   their own and a person they have authority over; never one's own role, never the owner's. The
--   permissions follow the role at once (they are derived from it); a person moved below manager stops
--   managing sites too (otherwise site scope would outlive the role); the direct grants that remain are
--   returned for review, and everything is in the action log. The role's plan rule still applies.
-- B-04: the people offered to review a leave request now include whoever holds approval through an
--   active delegation from the owner (full, or partial with leave.approve) - and drop out when it ends;
--   the server refuses anyone else, as before (request_prosm_time_leave checks the same list).

begin;

create or replace function public.prosm_time_leave_reviewers_for(p_user_id uuid)
returns table (id uuid, full_name text, is_owner boolean)
language sql
stable
security definer
set search_path = public
as $function$
    select u.id, u.full_name, u.is_owner
    from users u
    where u.organization_id = (select organization_id from users where id = p_user_id)
      and u.is_active and u.id <> p_user_id
      and (
          u.is_owner
          -- an active delegation from the owner: full, or partial including leave approval
          or public.prosm_time_is_owner_delegate(u.id)
          or 'leave.approve' = any(public.prosm_time_delegated_permissions(u.id))
          or (
              public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_user_id)
              and exists (
                  select 1 from site_assignments msa
                  join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = p_user_id
                  where msa.user_id = u.id and msa.role_at_site = 'manager'
              )
          )
      );
$function$;
revoke all on function public.prosm_time_leave_reviewers_for(uuid) from public, anon, authenticated;

create or replace function public.change_prosm_time_user_role(p_user_id uuid, p_role_key text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_target users%rowtype;
    v_from text;
    v_role_id uuid;
    v_new_rank integer;
    v_sites integer := 0;
    v_grants jsonb;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if v_reason is null or length(v_reason) < 3 then raise exception 'A REASON IS REQUIRED'; end if;
    select * into v_target from users where id = p_user_id and organization_id = v_org for update;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if v_target.id = v_caller then raise exception 'YOU CANNOT CHANGE YOUR OWN ROLE'; end if;
    if v_target.is_owner then raise exception 'THE OWNER''S ROLE CANNOT BE CHANGED'; end if;
    if p_role_key not in ('manager', 'supervisor', 'employee', 'read_only') then raise exception 'INVALID ROLE'; end if;
    select r.role_key into v_from from roles r where r.id = v_target.role_id;
    if v_from = p_role_key then raise exception 'THIS IS ALREADY THE PERSON''S ROLE'; end if;
    v_new_rank := case p_role_key when 'manager' then 3 when 'supervisor' then 2 else 1 end;
    if not public.current_prosm_time_user_is_real_owner() then
        if not public.prosm_time_user_has_permission_internal(v_caller, 'permissions.assign') then raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED'; end if;
        if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'YOU HAVE NO AUTHORITY OVER THIS PERSON'; end if;
        if v_new_rank >= public.prosm_time_role_rank(v_caller) or public.prosm_time_role_rank(p_user_id) >= public.prosm_time_role_rank(v_caller) then
            raise exception 'YOU CAN ONLY GIVE A ROLE BELOW YOUR OWN';
        end if;
    end if;
    perform public.prosm_time_check_role_plan(v_org, p_role_key);
    select id into v_role_id from roles where role_key = p_role_key;

    update users set role_id = v_role_id, updated_at = now() where id = p_user_id;
    -- below manager: no longer manages sites (site scope must not outlive the role)
    if p_role_key in ('employee', 'read_only') then
        update site_assignments set role_at_site = 'member' where user_id = p_user_id and role_at_site = 'manager';
        get diagnostics v_sites = row_count;
    end if;
    -- the direct grants that remain, for the reviewer to keep or withdraw
    select coalesce(jsonb_agg(jsonb_build_object('permission', p.permission_key, 'granted', o.is_granted) order by p.permission_key), '[]'::jsonb)
    into v_grants
    from user_permission_overrides o join permissions p on p.id = o.permission_id
    where o.user_id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state, context)
    values (v_org, v_caller, p_user_id, 'USER_ROLE_CHANGED', 'users', p_user_id, 'Changed a person''s role', v_reason,
            jsonb_build_object('role', v_from), jsonb_build_object('role', p_role_key),
            jsonb_build_object('managedSitesRemoved', v_sites, 'directGrants', v_grants));
    return jsonb_build_object('success', true, 'from', v_from, 'to', p_role_key, 'managedSitesRemoved', v_sites, 'directGrants', v_grants);
end;
$$;
revoke all on function public.change_prosm_time_user_role(uuid, text, text) from public, anon;
grant execute on function public.change_prosm_time_user_role(uuid, text, text) to authenticated;

commit;
