-- PROSM Time - live UX review, user-directed, confirmed real bug: a
-- Manager (site admin, exercising sites.manage) opening "Assign Member"
-- on a site could select the org's own OWNER as a candidate, and could
-- grant the "manager" site role to anyone - including themselves. Both
-- confirmed live (screenshot: amira adel, a Manager, saw "waleed aziz"
-- the Owner in the member picker, and could self-assign as site
-- manager). Confirmed with the user: a non-Owner caller may only add
-- role_key = 'employee' users, and only ever as role_at_site = 'member'
-- - granting the site-manager tier is Owner-only.
--
-- This is the authoritative, server-side enforcement - matches this
-- codebase's own established posture everywhere else (the client only
-- ever reflects a permission state, never enforces one). The frontend
-- fix (AssignSiteMemberModal.tsx) mirrors this same boundary for UX,
-- but this RPC is what actually protects it.

begin;

create or replace function public.set_prosm_time_site_assignment(
    p_site_id uuid,
    p_user_id uuid,
    p_role_at_site text default 'member'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
    v_target users%rowtype;
    v_target_role_key text;
    v_assignment_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    if p_role_at_site not in ('member', 'manager') then
        raise exception 'INVALID ROLE AT SITE';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        select r.role_key into v_target_role_key from roles r where r.id = v_target.role_id;

        if v_target.is_owner or v_target_role_key <> 'employee' then
            raise exception 'ONLY THE ORGANIZATION OWNER MAY ASSIGN NON-EMPLOYEE MEMBERS TO A SITE';
        end if;

        if p_role_at_site = 'manager' then
            raise exception 'ONLY THE ORGANIZATION OWNER MAY GRANT SITE MANAGER';
        end if;
    end if;

    insert into site_assignments (site_id, user_id, role_at_site, assigned_by)
    values (p_site_id, p_user_id, p_role_at_site, v_caller_id)
    on conflict (site_id, user_id)
    do update set role_at_site = excluded.role_at_site, assigned_by = excluded.assigned_by
    returning id into v_assignment_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, p_user_id, 'SITE_ASSIGNMENT_SET', 'site_assignments', v_assignment_id,
        v_target.full_name || ' assigned to site ' || v_site.name || ' as ' || p_role_at_site || '.'
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'SET PROSM TIME SITE ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

commit;
