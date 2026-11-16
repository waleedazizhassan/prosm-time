-- Phase F round 2 (owner 2026-11-16: "a button in a clear place that puts the organisation on the governance model we
-- want - centralised, decentralised or combined - with how each works, its permissions, workflow and life cycle").
-- 1. The approval mode now governs all three non-sensitive request kinds, not only leave:
--      leave (leave.approve), attendance permissions (attendance.manage_permissions), attendance corrections
--      (exceptions.manage). Same four modes, same rules, one decider for every kind.
--      direct        - anyone with authority over the person (site / department manager), HR, or the owner;
--      decentralized - the operational side (site / department manager); HR only when the person has none;
--      centralized   - HR only (the owner and deputies as fallback);
--      two_step      - "combined": the operational manager approves, then HR; nobody operational -> HR directly.
-- 2. One organisation-wide governance model (set_prosm_time_governance_model) sets all three kinds at once; the
--    per-kind setting stays for fine tuning. Owner only, audited (GOVERNANCE_MODEL_CHANGED).
-- 3. In direct / decentralized the old site rule for corrections (the session's site) still decides as before.
-- Sensitive matters - payroll, allowances, penalties, permissions, billing, keys, ownership - are untouched.
-- Rollback: re-run 20261117100000's prosm_time_leave_decider / prosm_time_has_operational_manager, review functions
-- from their previous definitions (20261025150000 permission review, 20261115170000 exception review), drop the new
-- functions and the approval_step columns of attendance_permissions / correction_requests.

begin;

alter table public.attendance_permissions add column if not exists approval_step smallint not null default 1 check (approval_step in (1, 2));
alter table public.correction_requests add column if not exists approval_step smallint not null default 1 check (approval_step in (1, 2));

create or replace function public.prosm_time_request_base_permission(p_kind text)
returns text
language sql
immutable
as $$
    select case p_kind when 'leave' then 'leave.approve' when 'permission' then 'attendance.manage_permissions' when 'correction' then 'exceptions.manage' end;
$$;

create or replace function public.prosm_time_has_operational_manager(p_subject uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from users u where u.organization_id = (select organization_id from users where id = p_subject) and u.is_active
          and not u.is_owner and public.prosm_time_user_has_permission_internal(u.id, public.prosm_time_request_base_permission(p_kind))
          and public.prosm_time_operational_over(u.id, p_subject)
    );
$$;
revoke all on function public.prosm_time_has_operational_manager(uuid, text) from public, anon, authenticated;

create or replace function public.prosm_time_has_operational_manager(p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.prosm_time_has_operational_manager(p_subject, 'leave'); $$;
revoke all on function public.prosm_time_has_operational_manager(uuid) from public, anon, authenticated;

-- may p_actor decide p_subject's request of p_kind at p_step (1 = operational, 2 = HR step of two_step)?
create or replace function public.prosm_time_request_decider(p_kind text, p_actor uuid, p_subject uuid, p_step smallint default 1)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_perm text := public.prosm_time_request_base_permission(p_kind);
    v_ops boolean;
    v_hr boolean;
begin
    if v_perm is null or p_actor is null or p_subject is null or p_actor = p_subject then return false; end if;
    select a.organization_id into v_org from users a join users s on s.id = p_subject and s.organization_id = a.organization_id
    where a.id = p_actor and a.is_active;
    if v_org is null then return false; end if;
    -- the owner, a full deputy, or a deputy given this kind's permission: always
    if exists (select 1 from users where id = p_actor and is_owner) or public.prosm_time_is_owner_delegate(p_actor)
       or v_perm = any(public.prosm_time_delegated_permissions(p_actor)) then
        return true;
    end if;
    v_hr := public.prosm_time_is_hr_approver(p_actor);
    v_ops := public.prosm_time_user_has_permission_internal(p_actor, v_perm) and public.prosm_time_operational_over(p_actor, p_subject);
    return case public.prosm_time_approval_mode(v_org, p_kind)
        when 'centralized' then v_hr
        when 'two_step' then case when p_step = 2 then v_hr else v_ops end
        when 'decentralized' then v_ops or (v_hr and not public.prosm_time_has_operational_manager(p_subject, p_kind))
        else v_ops or v_hr
    end;
end;
$$;
revoke all on function public.prosm_time_request_decider(text, uuid, uuid, smallint) from public, anon, authenticated;

create or replace function public.prosm_time_leave_decider(p_actor uuid, p_subject uuid, p_step smallint default 1)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.prosm_time_request_decider('leave', p_actor, p_subject, p_step); $$;
revoke all on function public.prosm_time_leave_decider(uuid, uuid, smallint) from public, anon, authenticated;

-- the step a pending request is really at (two_step with nobody operational starts at HR)
create or replace function public.prosm_time_request_effective_step(p_kind text, p_org uuid, p_subject uuid, p_step smallint)
returns smallint
language sql
stable
security definer
set search_path = public
as $$
    select case when p_step = 1 and public.prosm_time_approval_mode(p_org, p_kind) = 'two_step'
                     and not public.prosm_time_has_operational_manager(p_subject, p_kind) then 2::smallint else p_step end;
$$;
revoke all on function public.prosm_time_request_effective_step(text, uuid, uuid, smallint) from public, anon, authenticated;

-- the organisation's governance model: all three kinds at once
create or replace function public.set_prosm_time_governance_model(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_old jsonb;
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if not exists (select 1 from users where id = v_me and is_owner) then raise exception 'ONLY THE ORGANIZATION OWNER'; end if;
    if p_mode not in ('direct', 'decentralized', 'centralized', 'two_step') then raise exception 'INVALID REQUEST'; end if;
    v_old := public.get_prosm_time_approval_modes();
    insert into approval_modes (organization_id, request_kind, mode, updated_by)
    select v_org, k, p_mode, v_me from unnest(array['leave', 'permission', 'correction']) k
    on conflict (organization_id, request_kind) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now();
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, 'GOVERNANCE_MODEL_CHANGED', 'approval_modes', v_org, 'The organisation''s governance model was changed',
            v_old, jsonb_build_object('model', p_mode));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_governance_model(text) from public, anon;
grant execute on function public.set_prosm_time_governance_model(text) to authenticated;

-- attendance permission decisions ---------------------------------------------------------------------------------
do $$
declare
    v_def text;
    v_decl_old text := $q$declare
    v_row attendance_permissions%rowtype;
begin$q$;
    v_decl_new text := $q$declare
    v_row attendance_permissions%rowtype;
    v_caller uuid := public.current_prosm_time_user_id();
    v_step smallint;
begin$q$;
    v_auth_old text := $q$    perform public.prosm_time_require_permission_authority(v_row.user_id);$q$;
    v_auth_new text := $q$    -- phase F: who decides follows the organisation's approval mode (direct = as before, plus HR / department manager)
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') or public.prosm_time_is_hr_approver(v_caller)) then
        raise exception 'ATTENDANCE.MANAGE_PERMISSIONS AUTHORITY REQUIRED';
    end if;
    if v_row.user_id = v_caller then raise exception 'YOU CANNOT DECIDE YOUR OWN PERMISSION'; end if;
    v_step := public.prosm_time_request_effective_step('permission', v_row.organization_id, v_row.user_id, v_row.approval_step);
    if not public.prosm_time_request_decider('permission', v_caller, v_row.user_id, v_step) then
        if v_step = 2 then raise exception 'THIS REQUEST IS WAITING FOR HUMAN RESOURCES'; end if;
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;$q$;
    v_open_old text := $q$    perform public.prosm_time_require_day_open(v_row.user_id, v_row.work_date);$q$;
    v_open_new text := $q$    perform public.prosm_time_require_day_open(v_row.user_id, v_row.work_date);
    -- two_step: the operational approval hands it to HR (unless the same person may also decide step 2)
    if p_action = 'approved' and v_step = 1 and public.prosm_time_approval_mode(v_row.organization_id, 'permission') = 'two_step'
       and not public.prosm_time_request_decider('permission', v_caller, v_row.user_id, 2::smallint) then
        update attendance_permissions set approval_step = 2, updated_at = now() where id = p_id;
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
        values (v_row.organization_id, v_caller, v_row.user_id, 'attendance.permission_first_approval', 'attendance_permissions', p_id,
                'Permission approved by the manager - waiting for human resources', nullif(trim(coalesce(p_notes, '')), ''));
        return jsonb_build_object('success', true, 'awaiting', 'hr');
    end if;$q$;
begin
    v_def := replace(pg_get_functiondef('public.review_prosm_time_attendance_permission(uuid, text, boolean, numeric, integer, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_request_decider' in v_def) > 0 then return; end if;
    if position(v_decl_old in v_def) = 0 or position(v_auth_old in v_def) = 0 or position(v_open_old in v_def) = 0 then
        raise exception 'review permission: anchor not found';
    end if;
    execute replace(replace(replace(v_def, v_decl_old, v_decl_new), v_auth_old, v_auth_new), v_open_old, v_open_new);
end $$;

-- attendance correction decisions (inside review_prosm_time_exception) ------------------------------------------
do $$
declare
    v_def text;
    v_decl_old text := $q$    v_mock mock_location_flags%rowtype;
begin$q$;
    v_decl_new text := $q$    v_mock mock_location_flags%rowtype;
    v_step smallint;
    v_cr_mode text;
begin$q$;
    v_perm_old text := $q$        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then$q$;
    v_perm_new text := $q$        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        or (p_kind = 'correction_request' and public.prosm_time_is_hr_approver(v_caller_id))
    ) then$q$;
    v_auth_old text := $q$        if not public.prosm_time_caller_has_authority_over(v_cr.user_id,
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = v_cr.attendance_session_id)
        ) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;$q$;
    v_auth_new text := $q$        -- phase F: the approval mode decides who may decide; direct / decentralized keep the session-site rule too
        v_cr_mode := public.prosm_time_approval_mode(v_caller_org, 'correction');
        v_step := public.prosm_time_request_effective_step('correction', v_caller_org, v_cr.user_id, v_cr.approval_step);
        if not (
            public.prosm_time_request_decider('correction', v_caller_id, v_cr.user_id, v_step)
            or (v_cr_mode in ('direct', 'decentralized')
                and 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over(v_cr.user_id,
                    (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = v_cr.attendance_session_id)))
        ) then
            if v_step = 2 then raise exception 'THIS REQUEST IS WAITING FOR HUMAN RESOURCES'; end if;
            raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
        end if;
        -- two_step: the operational approval hands it to HR (unless the same person may also decide step 2)
        if p_action_type = 'approved' and v_step = 1 and v_cr_mode = 'two_step'
           and not public.prosm_time_request_decider('correction', v_caller_id, v_cr.user_id, 2::smallint) then
            update correction_requests set approval_step = 2 where id = p_target_id;
            insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
            values (v_caller_org, v_caller_id, v_cr.user_id, 'correction.first_approval', 'correction_requests', p_target_id,
                    'Correction approved by the manager - waiting for human resources', nullif(trim(coalesce(p_notes, '')), ''));
            return jsonb_build_object('success', true, 'awaiting', 'hr');
        end if;$q$;
begin
    v_def := replace(pg_get_functiondef('public.review_prosm_time_exception(text, uuid, text, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_request_decider' in v_def) > 0 then return; end if;
    if position(v_decl_old in v_def) = 0 or position(v_perm_old in v_def) = 0 or position(v_auth_old in v_def) = 0 then
        raise exception 'review exception: anchor not found';
    end if;
    execute replace(replace(replace(v_def, v_decl_old, v_decl_new), v_perm_old, v_perm_new), v_auth_old, v_auth_new);
end $$;

-- the queues: what the caller may decide now ---------------------------------------------------------------------
do $$
declare
    v_def text;
    v_gate_old text := $q$    if not public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') then$q$;
    v_gate_new text := $q$    if not (public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') or public.prosm_time_is_hr_approver(v_caller)) then$q$;
    v_filter_old text := $q$            where p.organization_id = v_org and p.status = 'pending' and p.user_id <> v_caller
              and public.prosm_time_caller_has_authority_over(p.user_id)$q$;
    v_filter_new text := $q$            where p.organization_id = v_org and p.status = 'pending' and p.user_id <> v_caller
              and public.prosm_time_request_decider('permission', v_caller, p.user_id,
                    public.prosm_time_request_effective_step('permission', v_org, p.user_id, p.approval_step))$q$;
begin
    v_def := replace(pg_get_functiondef('public.list_prosm_time_permission_queue()'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_request_decider' in v_def) > 0 then return; end if;
    if position(v_gate_old in v_def) = 0 or position(v_filter_old in v_def) = 0 then raise exception 'permission queue: anchor not found'; end if;
    execute replace(replace(v_def, v_gate_old, v_gate_new), v_filter_old, v_filter_new);
end $$;

-- corrections the caller may decide now (the review screen read the table and filtered by role; HR and department
-- managers decide people outside their sites, so the server lists them)
create or replace function public.list_prosm_time_correction_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_mode text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_mode := public.prosm_time_approval_mode(v_org, 'correction');
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', cr.id, 'userId', cr.user_id, 'fullName', u.full_name, 'eventType', cr.proposed_event_type,
                                            'correctTime', cr.proposed_correct_time, 'reason', cr.reason, 'createdAt', cr.created_at,
                                            'approvalStep', public.prosm_time_request_effective_step('correction', v_org, cr.user_id, cr.approval_step))
                         order by cr.created_at desc)
        from correction_requests cr join users u on u.id = cr.user_id
        where cr.organization_id = v_org and cr.status = 'pending' and cr.user_id <> v_caller
          and (
              public.prosm_time_request_decider('correction', v_caller, cr.user_id,
                  public.prosm_time_request_effective_step('correction', v_org, cr.user_id, cr.approval_step))
              or (v_mode in ('direct', 'decentralized')
                  and 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller), array[]::text[]))
                  and public.prosm_time_caller_has_authority_over(cr.user_id,
                      (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = cr.attendance_session_id)))
          )
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_correction_queue() from public, anon;
grant execute on function public.list_prosm_time_correction_queue() to authenticated;

-- what the governance screen needs: the modes, and whether the people each model relies on exist
create or replace function public.get_prosm_time_governance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER'; end if;
    return jsonb_build_object(
        'modes', public.get_prosm_time_approval_modes(),
        'hrApprovers', (select count(*) from users u where u.organization_id = v_org and u.is_active and not u.is_owner
                        and public.prosm_time_is_hr_approver(u.id)),
        'siteManagers', (select count(distinct sa.user_id) from site_assignments sa join users u on u.id = sa.user_id
                         where u.organization_id = v_org and u.is_active and sa.role_at_site = 'manager'),
        'departmentManagers', (select count(distinct d.manager_user_id) from departments d
                               where d.organization_id = v_org and d.is_active and d.manager_user_id is not null));
end;
$$;
revoke all on function public.get_prosm_time_governance_overview() from public, anon;
grant execute on function public.get_prosm_time_governance_overview() to authenticated;

commit;
