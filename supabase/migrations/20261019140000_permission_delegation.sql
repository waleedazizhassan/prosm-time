-- Owner 2026-10-19: "the Owner holds every permission and can give some of
-- them to others; Managers and Supervisors manage their basic permissions
-- plus what the Owner gives a Manager and a Manager gives a Supervisor."
--
-- * The Owner (and anyone the Owner gave permissions.assign) changes
--   anyone's permissions except the Owner's, as before.
-- * A Manager can now give to, or take from, a Supervisor ranked below them
--   at a site they manage - only permissions the Manager holds, and never
--   permissions.assign, administrators.manage, leave approval or acting on
--   someone's behalf. A Manager can see those Supervisors' permissions.
-- * Leave approval and clocking in/out on someone's behalf can only be
--   given to Managers - by anyone, the Owner included.

begin;

create or replace function public.prosm_time_manager_only_permissions()
returns text[]
language sql
immutable
set search_path = public
as $function$
    select array['leave.approve', 'attendance.clock_in_on_behalf', 'attendance.clock_out_on_behalf'];
$function$;

revoke execute on function public.prosm_time_manager_only_permissions() from public, anon;
grant execute on function public.prosm_time_manager_only_permissions() to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_prosm_time_user_permission_override(p_target_user_id uuid, p_permission_key text, p_is_granted boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_target users%rowtype;
    v_permission_id uuid;
    v_override_id uuid;
    v_target_role text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        or public.current_prosm_time_user_role_key() = 'manager'
    ) then
        raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_target from users where id = p_target_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    if v_target.is_owner then
        raise exception 'THE OWNER''S AUTHORITY CANNOT BE OVERRIDDEN';
    end if;

    select r.role_key into v_target_role from roles r where r.id = v_target.role_id;
    -- A Manager passes on to Supervisors at their sites only what they hold themselves.
    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        if v_target_role <> 'supervisor' or not public.prosm_time_caller_has_authority_over(p_target_user_id) then
            raise exception 'A MANAGER MAY ONLY CHANGE THE PERMISSIONS OF SUPERVISORS AT THEIR SITES';
        end if;
        if p_permission_key = any(public.prosm_time_manager_only_permissions() || array['permissions.assign', 'administrators.manage'])
           or not (p_permission_key = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
            raise exception 'A MANAGER MAY ONLY PASS ON PERMISSIONS THEY HOLD';
        end if;
    end if;
    -- Leave approval and acting on someone's behalf stay with Managers (owner 2026-10-19).
    if p_is_granted and p_permission_key = any(public.prosm_time_manager_only_permissions()) and v_target_role <> 'manager' then
        raise exception 'THIS PERMISSION IS FOR MANAGERS ONLY';
    end if;

    select id into v_permission_id from permissions where permission_key = p_permission_key;
    if v_permission_id is null then
        raise exception 'UNKNOWN PERMISSION KEY';
    end if;

    insert into user_permission_overrides (user_id, permission_id, is_granted, granted_by, reason)
    values (p_target_user_id, v_permission_id, p_is_granted, v_caller_id, p_reason)
    on conflict (user_id, permission_id)
    do update set is_granted = excluded.is_granted, granted_by = excluded.granted_by, reason = excluded.reason, created_at = now()
    returning id into v_override_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_target_user_id,
        case when p_is_granted then 'PERMISSION_GRANTED' else 'PERMISSION_REVOKED' end,
        'user_permission_overrides', v_override_id,
        'Permission ' || p_permission_key || (case when p_is_granted then ' granted to ' else ' revoked from ' end) || v_target.email || '.',
        p_reason, jsonb_build_object('permissionKey', p_permission_key, 'isGranted', p_is_granted)
    );

    return jsonb_build_object('success', true, 'overrideId', v_override_id);
exception
    when others then
        raise exception 'SET PROSM TIME USER PERMISSION OVERRIDE FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.clear_prosm_time_user_permission_override(p_target_user_id uuid, p_permission_key text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_permission_id uuid;
    v_target_role text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        or public.current_prosm_time_user_role_key() = 'manager'
    ) then
        raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    if not exists (select 1 from users where id = p_target_user_id and organization_id = v_caller_org) then
        raise exception 'USER NOT FOUND';
    end if;

    select r.role_key into v_target_role from users u join roles r on r.id = u.role_id where u.id = p_target_user_id;
    if exists (select 1 from users where id = p_target_user_id and is_owner) then
        raise exception 'THE OWNER''S AUTHORITY CANNOT BE OVERRIDDEN';
    end if;
    -- A Manager passes on to Supervisors at their sites only what they hold themselves.
    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        if v_target_role <> 'supervisor' or not public.prosm_time_caller_has_authority_over(p_target_user_id) then
            raise exception 'A MANAGER MAY ONLY CHANGE THE PERMISSIONS OF SUPERVISORS AT THEIR SITES';
        end if;
        if p_permission_key = any(public.prosm_time_manager_only_permissions() || array['permissions.assign', 'administrators.manage'])
           or not (p_permission_key = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
            raise exception 'A MANAGER MAY ONLY PASS ON PERMISSIONS THEY HOLD';
        end if;
    end if;
    -- Leave approval and acting on someone's behalf stay with Managers (owner 2026-10-19).
    if false and p_permission_key = any(public.prosm_time_manager_only_permissions()) and v_target_role <> 'manager' then
        raise exception 'THIS PERMISSION IS FOR MANAGERS ONLY';
    end if;

    select id into v_permission_id from permissions where permission_key = p_permission_key;
    if v_permission_id is null then
        raise exception 'UNKNOWN PERMISSION KEY';
    end if;

    delete from user_permission_overrides where user_id = p_target_user_id and permission_id = v_permission_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_target_user_id, 'PERMISSION_OVERRIDE_CLEARED', 'user_permission_overrides', p_target_user_id,
        'Permission override for ' || p_permission_key || ' cleared - reverted to role default.', p_reason,
        jsonb_build_object('permissionKey', p_permission_key)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CLEAR PROSM TIME USER PERMISSION OVERRIDE FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_prosm_time_effective_permissions(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_target_id uuid;
    v_caller_org uuid;
    v_target_org uuid;
    v_caller_permissions text[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    v_target_id := coalesce(p_user_id, v_caller_id);

    if v_target_id <> v_caller_id then
        v_caller_org := public.current_prosm_time_organization_id();
        select organization_id into v_target_org from users where id = v_target_id;
        if v_target_org is null or v_target_org <> v_caller_org then
            raise exception 'USER NOT FOUND';
        end if;

        select array_agg(p.permission_key) into v_caller_permissions
        from role_default_permissions rdp
        join permissions p on p.id = rdp.permission_id
        join roles r on r.id = rdp.role_id
        join users u on u.role_id = rdp.role_id
        where u.id = v_caller_id
          and (
              r.role_key <> 'manager'
              or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
              or rdp.permission_id in (
                  select rdp2.permission_id
                  from role_default_permissions rdp2
                  join roles r2 on r2.id = rdp2.role_id
                  where r2.role_key = 'employee'
              )
          );

        if not (
            'administrators.manage' = any(coalesce(v_caller_permissions, array[]::text[]))
            or 'permissions.assign' = any(coalesce(v_caller_permissions, array[]::text[]))
            or public.current_prosm_time_user_is_owner()
            or (public.current_prosm_time_user_role_key() = 'manager' and public.prosm_time_caller_has_authority_over(v_target_id))
        ) then
            raise exception 'INSUFFICIENT AUTHORITY TO VIEW ANOTHER USER''S PERMISSIONS';
        end if;
    end if;

    return (
        select array_agg(distinct permission_key) from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join roles r on r.id = rdp.role_id
            join users u on u.role_id = rdp.role_id
            where u.id = v_target_id
              and (
                  r.role_key <> 'manager'
                  or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
                  or rdp.permission_id in (
                      select rdp2.permission_id
                      from role_default_permissions rdp2
                      join roles r2 on r2.id = rdp2.role_id
                      where r2.role_key = 'employee'
                  )
              )
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = false
        ) effective
    );
exception
    when others then
        raise exception 'GET PROSM TIME EFFECTIVE PERMISSIONS FAILED: %', sqlerrm;
end;
$function$;

commit;
