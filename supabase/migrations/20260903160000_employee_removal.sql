-- PROSM Time - live UX review, user-directed correction: "I asked for
-- a button to remove an employee from the application - only
-- deactivation got built, not actual removal." Deactivation (previous
-- migration) is reversible and keeps history - genuinely useful, kept
-- as-is. This is the real, permanent removal: the employee's users row
-- (and everything that cascades from it - attendance, timesheets,
-- notifications, device bindings, site/project assignments,
-- permission overrides) is deleted outright, and their Supabase Auth
-- account is deleted too (via the paired edge function, service-role
-- only - not something plain SQL can do).
--
-- Same two-step "authorize under the caller's own session, execute
-- under service role" shape as the existing delete-employee-data flow
-- (authorize_prosm_time_employee_data_deletion /
-- delete_prosm_time_employee_data) - Owner-only here specifically
-- (the user was explicit), reason required, blocked while a retention
-- hold applies or the employee is currently clocked in (same checks),
-- and ADDITIONALLY blocked if this employee ever acted as a reviewer/
-- approver on someone ELSE's record (exception_actions/
-- timesheet_approvals/timesheet_corrections/admin_on_behalf_actions
-- all RESTRICT on that actor reference) - removing them would silently
-- destroy a different employee's own audit trail, which deactivation
-- (not removal) is the right tool for instead.

begin;

create or replace function public.authorize_prosm_time_employee_removal(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target users%rowtype;
    v_has_timesheet_hold boolean;
    v_has_open_session boolean;
    v_has_review_history boolean;
    v_evidence jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if v_target.organization_id <> public.current_prosm_time_organization_id() then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY REMOVE AN EMPLOYEE';
    end if;

    if p_user_id = v_caller_id then
        raise exception 'YOU CANNOT REMOVE YOUR OWN ACCOUNT';
    end if;

    select exists (
        select 1 from timesheets where user_id = p_user_id and (status in ('submitted', 'approved') or approved_at is not null)
    ) into v_has_timesheet_hold;

    select exists (
        select 1 from attendance_sessions where user_id = p_user_id and status = 'clocked_in'
    ) into v_has_open_session;

    select exists (
        select 1 from exception_actions where actor_user_id = p_user_id
        union all select 1 from timesheet_approvals where actor_user_id = p_user_id
        union all select 1 from timesheet_corrections where requested_by = p_user_id
        union all select 1 from admin_on_behalf_actions where actor_user_id = p_user_id or subject_user_id = p_user_id
    ) into v_has_review_history;

    if v_has_timesheet_hold then
        return jsonb_build_object('success', true, 'authorized', false, 'callerUserId', v_caller_id, 'reason', 'This employee has a submitted, approved, or previously-approved timesheet - retained per legal/payroll requirements.');
    end if;

    if v_has_open_session then
        return jsonb_build_object('success', true, 'authorized', false, 'callerUserId', v_caller_id, 'reason', 'This employee is currently clocked in - clock them out before removing them.');
    end if;

    if v_has_review_history then
        return jsonb_build_object('success', true, 'authorized', false, 'callerUserId', v_caller_id, 'reason', 'This employee reviewed or approved records for other employees - removing them would destroy that history. Deactivate them instead.');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', ce.id, 'storagePath', ce.storage_path)), '[]'::jsonb)
    into v_evidence
    from camera_evidence ce
    where ce.user_id = p_user_id;

    return jsonb_build_object('success', true, 'authorized', true, 'callerUserId', v_caller_id, 'evidence', v_evidence);
exception
    when others then
        raise exception 'AUTHORIZE PROSM TIME EMPLOYEE REMOVAL FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.authorize_prosm_time_employee_removal(uuid) from public, anon;
grant execute on function public.authorize_prosm_time_employee_removal(uuid) to authenticated;

create or replace function public.remove_prosm_time_employee(
    p_user_id uuid,
    p_actor_user_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_target users%rowtype;
begin
    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'A REASON IS REQUIRED';
    end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    -- Written while the row still exists - audit_logs.subject_user_id
    -- is ON DELETE SET NULL, so this row survives the delete below
    -- with its description intact, just losing the FK link.
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_target.organization_id, p_actor_user_id, p_user_id, 'EMPLOYEE_REMOVED', 'users', p_user_id,
        v_target.full_name || ' (' || v_target.email || ') removed from the application entirely.', trim(p_reason)
    );

    -- Every real per-user table (attendance, timesheets, notifications,
    -- device bindings, site/project assignments, permission overrides,
    -- invitations) cascades from this delete - only the RESTRICT-guarded
    -- reviewer/approver tables would block it, and authorize_prosm_time_
    -- employee_removal already refused those cases before this ever runs.
    delete from users where id = p_user_id;

    return jsonb_build_object('success', true, 'authUserId', v_target.auth_user_id);
exception
    when others then
        raise exception 'REMOVE PROSM TIME EMPLOYEE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.remove_prosm_time_employee(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.remove_prosm_time_employee(uuid, uuid, text) to service_role;

commit;
