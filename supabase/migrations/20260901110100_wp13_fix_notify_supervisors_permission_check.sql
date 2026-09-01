-- Fix: notify_prosm_time_supervisors called the public-facing
-- get_prosm_time_effective_permissions(u.id) for each CANDIDATE
-- supervisor - that function enforces "caller must hold
-- administrators.manage/permissions.assign to inspect someone else's
-- permissions" (§9), which is correct for its real client-facing
-- callers but wrong here: this is an internal system lookup running
-- as SECURITY DEFINER, not a user-initiated permission inspection.
-- Found via live testing (a plain employee's Clock In failed entirely
-- because notifying supervisors tried to inspect the manager's
-- permissions using the EMPLOYEE's own caller authority). Fixed by
-- inlining the same effective-permission computation directly,
-- without the caller-authorization gate that was never meant to apply
-- to this internal path.
create or replace function public.notify_prosm_time_supervisors(
    p_organization_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_supervisor record;
    v_permissions text[];
begin
    for v_supervisor in
        select id, is_owner from users where organization_id = p_organization_id
    loop
        if v_supervisor.is_owner then
            perform public.create_prosm_time_notification(p_organization_id, v_supervisor.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
            continue;
        end if;

        select array_agg(distinct permission_key) into v_permissions from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join users u on u.role_id = rdp.role_id
            where u.id = v_supervisor.id
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_supervisor.id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_supervisor.id and upo.is_granted = false
        ) effective;

        if 'exceptions.manage' = any(coalesce(v_permissions, array[]::text[])) or 'attendance.clock_out_on_behalf' = any(coalesce(v_permissions, array[]::text[])) then
            perform public.create_prosm_time_notification(p_organization_id, v_supervisor.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
        end if;
    end loop;
end;
$function$;
