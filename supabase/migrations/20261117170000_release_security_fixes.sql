-- Release audit 2026-11-16 (security / architecture / governance review before the public release). Fixes:
--   SA-01 identity confirmation (step-up / MFA) now also guards: permission changes (set / clear / reset), role
--         changes, giving the owner's authority, locking a payroll cycle, the bulk payslip export - as the security
--         screen promises.
--   SA-02 nobody but the real owner changes their own permissions (a full deputy could grant themselves lasting
--         permissions that outlived the delegation).
--   SA-03 a department manager and an HR approver decide only for people below them (rank), never the owner's;
--         hr.approve_all_requests is a managers-only permission; nobody but the owner appoints themselves a
--         department manager, and a department manager is a manager (or the owner).
--   SA-04 a meeting is joined only by its host, its invitees and those already in it (a hand-written
--         "meeting_invite" row let an uninvited person in); members can no longer write meeting invitations.
--   SA-06 call usage is counted only for a call or meeting the reporter took part in, and never more than the
--         connection could carry (one report could switch the relays off for every organisation).
--   SA-07 "two-step verification for the owner" applies to the owner on every plan.
--   SA-08 payroll staff never change their own pay (profile, components, cycle lines) - only the real owner.
--   SA-09 moving an administration's permission set from someone the giver has no authority over is refused.
--   SA-10 the pay-period lock also covers attendance permissions and day adjustments (a locked payroll month).
-- Rollback: re-run the previous definitions (listed per function in docs/qa/RELEASE_AUDIT_2026-11-16.md).

begin;

-- a guard right after a function's first "begin" (functions patched in place, everything else unchanged)
create or replace function pg_temp.guard_after_begin(p_sig regprocedure, p_marker text, p_guard text)
returns void
language plpgsql
as $$
declare
    v_def text := replace(pg_get_functiondef(p_sig), chr(13) || chr(10), chr(10));
begin
    if position(p_marker in v_def) > 0 then return; end if;
    if (regexp_match(v_def, E'\\n[ \\t]*begin[ \\t]*\\n', 'i')) is null then raise exception 'no begin in %', p_sig; end if;
    execute regexp_replace(v_def, E'(\\n[ \\t]*begin[ \\t]*\\n)', E'\\1' || replace(p_guard, '\', '\\') || chr(10), 'i');
end;
$$;

-- SA-01 + SA-02 ----------------------------------------------------------------------------------------------------
select pg_temp.guard_after_begin('public.set_prosm_time_user_permission_override(uuid, text, boolean, text)'::regprocedure, 'SA-02 self',
$g$    -- SA-02 self: only the real owner changes their own permissions; SA-01: identity confirmation when the organisation asks for it
    if p_target_user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PERMISSIONS';
    end if;
    perform public.prosm_time_require_step_up('permissions.change');$g$);
select pg_temp.guard_after_begin('public.clear_prosm_time_user_permission_override(uuid, text, text)'::regprocedure, 'SA-02 self',
$g$    -- SA-02 self: only the real owner changes their own permissions; SA-01: identity confirmation when the organisation asks for it
    if p_target_user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PERMISSIONS';
    end if;
    perform public.prosm_time_require_step_up('permissions.change');$g$);
select pg_temp.guard_after_begin('public.reset_prosm_time_user_permissions(uuid, text)'::regprocedure, 'SA-02 self',
$g$    -- SA-02 self: only the real owner changes their own permissions; SA-01: identity confirmation when the organisation asks for it
    if p_target_user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PERMISSIONS';
    end if;
    perform public.prosm_time_require_step_up('permissions.change');$g$);
select pg_temp.guard_after_begin('public.change_prosm_time_user_role(uuid, text, text)'::regprocedure, 'SA-01 role',
$g$    -- SA-01 role: identity confirmation when the organisation asks for it
    perform public.prosm_time_require_step_up('roles.change');$g$);
select pg_temp.guard_after_begin('public.grant_prosm_time_owner_authority(uuid, text, timestamptz, timestamptz, text, text[])'::regprocedure, 'SA-01 delegate',
$g$    -- SA-01 delegate: identity confirmation when the organisation asks for it
    perform public.prosm_time_require_step_up('owner.delegate');$g$);
select pg_temp.guard_after_begin('public.start_prosm_time_payroll_export_job(uuid, uuid[])'::regprocedure, 'SA-01 export',
$g$    -- SA-01 export: identity confirmation when the organisation asks for it
    perform public.prosm_time_require_step_up('payroll.export');$g$);
do $$
declare
    v_sig regprocedure := 'public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$    elsif p_action = 'lock' then
        perform public.prosm_time_payroll_require('payroll.approve', v_cycle.site_id);$q$;
    v_new text := $q$    elsif p_action = 'lock' then
        perform public.prosm_time_payroll_require('payroll.approve', v_cycle.site_id);
        perform public.prosm_time_require_step_up('payroll.lock');$q$;
begin
    if position('payroll.lock' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'payroll lock: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

-- SA-03 ------------------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_manager_only_permissions()
returns text[]
language sql
immutable
set search_path to 'public'
as $$
    select array['leave.approve', 'attendance.clock_in_on_behalf', 'attendance.clock_out_on_behalf', 'hr.approve_all_requests'];
$$;

create or replace function public.prosm_time_operational_over(p_actor uuid, p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select p_actor <> p_subject and (
        public.prosm_time_user_has_authority_over(p_actor, p_subject)
        or (
            -- the department's manager, over the department's people below them (never the owner, never a peer)
            public.prosm_time_can_act_on_behalf_of(p_actor, p_subject)
            and exists (select 1 from users s join departments d on d.id = s.department_id and d.organization_id = s.organization_id and d.is_active
                        where s.id = p_subject and d.manager_user_id = p_actor)
        )
    );
$$;
revoke all on function public.prosm_time_operational_over(uuid, uuid) from public, anon, authenticated;

create or replace function public.prosm_time_is_hr_approver(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_user_has_permission_internal(p_actor, 'hr.approve_all_requests');
$$;

do $$
declare
    v_sig regprocedure := 'public.prosm_time_request_decider(text, uuid, uuid, smallint)'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$    v_hr := public.prosm_time_is_hr_approver(p_actor);$q$;
    v_new text := $q$    -- SA-03: HR decides for people below them only (never the owner, never a peer or a superior)
    v_hr := public.prosm_time_is_hr_approver(p_actor) and public.prosm_time_can_act_on_behalf_of(p_actor, p_subject);$q$;
begin
    if position('SA-03' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'decider: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

select pg_temp.guard_after_begin('public.set_prosm_time_department_manager(uuid, uuid)'::regprocedure, 'SA-03 appoint',
$g$    -- SA-03 appoint: nobody but the owner appoints themselves; a department manager is a manager (or the owner)
    if p_user is not null then
        if p_user = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
            raise exception 'YOU CANNOT APPOINT YOURSELF';
        end if;
        if not exists (select 1 from users u left join roles r on r.id = u.role_id
                       where u.id = p_user and (u.is_owner or r.role_key = 'manager')) then
            raise exception 'A DEPARTMENT MANAGER MUST HAVE THE MANAGER ROLE';
        end if;
    end if;$g$);

-- SA-04 ------------------------------------------------------------------------------------------------------------
do $$
declare
    v_sig regprocedure := 'public.prosm_time_connect_join_meeting(uuid)'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$
       and not exists (select 1 from connect_switchboard s join connect_receipts r on r.item_id = s.id
                       where s.ref_id = p_meeting_id and s.type = 'meeting_invite' and r.recipient_id = v_me)
       and not exists (select 1 from connect_switchboard s where s.ref_id = p_meeting_id and s.type = 'meeting_invite' and s.to_user = v_me) then$q$;
    v_new text := $q$ then$q$;
begin
    if position('connect_switchboard' in v_def) = 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'join meeting: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

do $$
declare
    v_sig regprocedure := 'public.prosm_time_connect_may_send(uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz, text)'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$    select p_from = public.current_prosm_time_user_id()$q$;
    v_new text := $q$    select p_from = public.current_prosm_time_user_id()
       and p_type <> 'meeting_invite'$q$;
begin
    if position('meeting_invite' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'may send: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

-- SA-06 ------------------------------------------------------------------------------------------------------------
do $$
declare
    v_sig regprocedure := 'public.record_prosm_time_connect_usage(text, uuid, text, text, bigint, integer)'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$    if p_route <> 'relay' then v_server := null; end if;$q$;
    v_new text := $q$    -- SA-06: only a call or meeting the reporter took part in, and never more than the connection could carry
    -- (3.2 Mbit/s - above the 360p / 15 fps video and audio sent and received)
    if p_ref_id is null
       or not (exists (select 1 from connect_calls c where c.id = p_ref_id and c.organization_id = v_org and v_me in (c.caller_id, c.callee_id))
               or public.prosm_time_connect_meeting_party(p_ref_id, v_me)) then
        raise exception 'INVALID USAGE';
    end if;
    if p_bytes > greatest(p_seconds, 1)::bigint * 400000 then raise exception 'INVALID USAGE'; end if;
    if p_route <> 'relay' then v_server := null; end if;$q$;
begin
    if position('SA-06' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'usage: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

-- SA-07 ------------------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_user_requires_mfa(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    select public.prosm_time_step_up_flag('mfa_required')
       and exists (select 1 from users u where u.id = p_user_id and u.is_active)
       and (
           -- the owner on every plan (SA-07); the payroll and permission holders where the plan has payroll
           exists (select 1 from users where id = p_user_id and is_owner)
           or (
               exists (select 1 from users u where u.id = p_user_id and public.prosm_time_plan_allows(u.organization_id, 'payroll'))
               and (public.prosm_time_user_has_permission_internal(p_user_id, 'payroll.approve')
                    or public.prosm_time_user_has_permission_internal(p_user_id, 'payroll.reopen'))
           )
           or public.prosm_time_user_has_permission_internal(p_user_id, 'permissions.assign')
       );
$$;

-- SA-08 ------------------------------------------------------------------------------------------------------------
select pg_temp.guard_after_begin('public.save_prosm_time_payroll_profile(uuid, jsonb)'::regprocedure, 'SA-08 own pay',
$g$    -- SA-08 own pay: payroll staff never change their own pay; only the real owner
    if p_user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PAY';
    end if;$g$);
select pg_temp.guard_after_begin('public.set_prosm_time_payroll_profile_component(uuid, uuid, numeric, numeric, date)'::regprocedure, 'SA-08 own pay',
$g$    -- SA-08 own pay: payroll staff never change their own pay; only the real owner
    if p_user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PAY';
    end if;$g$);
select pg_temp.guard_after_begin('public.save_prosm_time_payroll_line(uuid, uuid, uuid, numeric, text, integer, text, jsonb)'::regprocedure, 'SA-08 own pay',
$g$    -- SA-08 own pay: payroll staff never change their own lines; only the real owner (imports and the system go
    -- through other paths)
    if exists (select 1 from payroll_cycle_employees ce where ce.id = p_cycle_employee_id and ce.user_id = public.current_prosm_time_user_id())
       and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'YOU CANNOT CHANGE YOUR OWN PAY';
    end if;$g$);

-- SA-09 ------------------------------------------------------------------------------------------------------------
do $$
declare
    v_sig regprocedure := 'public.prosm_time_management_move()'::regprocedure;
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    v_old text := $q$        for v_holder in select * from public.prosm_time_management_holders(v_org, v_set, new.user_id) loop
$q$;
    v_new text := $q$        for v_holder in select * from public.prosm_time_management_holders(v_org, v_set, new.user_id) loop
            -- SA-09: the giver must have authority over the person who loses it (the owner always has)
            if v_actor is not null
               and not exists (select 1 from users where id = v_actor and is_owner)
               and not public.prosm_time_is_owner_delegate(v_actor)
               and not public.prosm_time_can_act_on_behalf_of(v_actor, v_holder.id) then
                raise exception 'THIS ADMINISTRATION IS HELD BY SOMEONE ELSE - ONLY THE OWNER CAN MOVE IT';
            end if;
$q$;
begin
    if position('SA-09' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'management move: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

-- SA-10 ------------------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_require_day_open(p_user_id uuid, p_day date)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if exists (select 1 from timesheets t where t.user_id = p_user_id and t.status in ('approved', 'locked') and p_day between t.period_start and t.period_end)
       or exists (select 1 from allowance_entries e where e.user_id = p_user_id and e.entry_date = p_day and e.status = 'approved') then
        raise exception 'THE TIMESHEET FOR THIS PERIOD IS ALREADY APPROVED';
    end if;
    -- SA-10: an approved / locked payroll month is closed for these changes too
    if public.prosm_time_pay_period_locked(p_user_id, p_day, p_day) then
        raise exception 'THIS PAY PERIOD IS LOCKED';
    end if;
end;
$function$;
revoke all on function public.prosm_time_require_day_open(uuid, date) from public, anon, authenticated;

commit;
