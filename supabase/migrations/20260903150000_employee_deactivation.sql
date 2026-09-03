-- PROSM Time - live UX review, user-directed: "an urgent button to
-- delete an employee from the application - requires a reason, and is
-- Owner-only authority." The existing delete-employee-data flow
-- (WP-22/§24) purges attendance HISTORY on request but deliberately
-- never touches the account itself - the employee could still sign in
-- afterward. This is a different, additive capability: revoke an
-- employee's access to the app entirely (they can no longer sign in,
-- every RLS policy and RPC in this app stops recognizing them) while
-- preserving their historical data, reversible by an Owner.
--
-- Implementation: current_prosm_time_user_id() is the one choke point
-- nearly everything in this schema resolves the caller through - a
-- deactivated user simply stops resolving to a user id at all (same
-- as "NO AUTHENTICATED SESSION" everywhere), without touching
-- Supabase Auth's own managed auth.users table at all.

begin;

alter table public.users
    add column is_active boolean not null default true,
    add column deactivated_at timestamptz,
    add column deactivated_by uuid references public.users(id),
    add column deactivation_reason text;

create or replace function public.current_prosm_time_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select id from public.users where auth_user_id = auth.uid() and is_active = true;
$function$;

create or replace function public.deactivate_prosm_time_employee(
    p_user_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_target users%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY DEACTIVATE AN EMPLOYEE';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'A REASON IS REQUIRED';
    end if;

    if p_user_id = v_caller_id then
        raise exception 'YOU CANNOT DEACTIVATE YOUR OWN ACCOUNT';
    end if;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if not v_target.is_active then raise exception 'THIS EMPLOYEE IS ALREADY DEACTIVATED'; end if;

    if exists (select 1 from attendance_sessions where user_id = p_user_id and status = 'clocked_in') then
        raise exception 'THIS EMPLOYEE IS CURRENTLY CLOCKED IN';
    end if;

    update users
    set is_active = false, deactivated_at = now(), deactivated_by = v_caller_id, deactivation_reason = trim(p_reason)
    where id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_caller_org, v_caller_id, p_user_id, 'EMPLOYEE_DEACTIVATED', 'users', p_user_id, v_target.full_name || ' deactivated - can no longer sign in.', trim(p_reason));

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DEACTIVATE PROSM TIME EMPLOYEE FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.reactivate_prosm_time_employee(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_target users%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY REACTIVATE AN EMPLOYEE';
    end if;

    select * into v_target from users where id = p_user_id and organization_id = v_caller_org;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if v_target.is_active then raise exception 'THIS EMPLOYEE IS ALREADY ACTIVE'; end if;

    update users
    set is_active = true, deactivated_at = null, deactivated_by = null, deactivation_reason = null
    where id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_caller_org, v_caller_id, p_user_id, 'EMPLOYEE_REACTIVATED', 'users', p_user_id, v_target.full_name || ' reactivated - can sign in again.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REACTIVATE PROSM TIME EMPLOYEE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.deactivate_prosm_time_employee(uuid, text) from public, anon;
grant execute on function public.deactivate_prosm_time_employee(uuid, text) to authenticated;
revoke all on function public.reactivate_prosm_time_employee(uuid) from public, anon;
grant execute on function public.reactivate_prosm_time_employee(uuid) to authenticated;

commit;
