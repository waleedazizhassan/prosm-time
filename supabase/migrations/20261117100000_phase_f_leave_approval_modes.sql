-- Phase F, round 1 - leave (owner approved 2026-11-16; docs/governance/PHASE_F_APPROVAL_MODES.md).
-- How an organisation's leave requests are decided - one setting, four ways:
--   direct (default - today's behaviour): anyone with authority over the person decides, in one step;
--   decentralized: the operational side first in the list (site manager, then department manager), then HR, then
--                  the owner - one step, the first to decide closes it;
--   centralized:   HR decides (the owner as fallback);
--   two_step:      the operational manager (site or department) approves, THEN HR - both. Nobody operational over
--                  the person -> straight to HR; one person holding both closes both steps.
-- New authority sources (non-sensitive requests only - payroll, permissions, billing, keys, ownership unchanged):
--   * the department manager (departments.manager_user_id) over the members of that department;
--   * hr.approve_all_requests - over every employee of the organisation.
-- The owner and the owner's deputies decide everything, always. Nobody decides their own request (as before).
-- One function (prosm_time_leave_decider) answers "may this person decide this request at this step" for the
-- decision itself, the pending list and the "send the request to" list - they cannot disagree.
-- Rollback: drop approval_modes / the functions below / leave_requests.approval_step; re-run review_prosm_time_leave
-- from 20261115170000, list_prosm_time_pending_leave_requests from 20261019130000 and prosm_time_leave_reviewers_for
-- from 20261113235000.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('hr.approve_all_requests', 'hr', 'APPROVE', 'Decide every employee''s non-sensitive requests',
     'Human resources: decide leave (and, later, permissions and attendance corrections) for every employee. No payroll, no permissions.')
on conflict (permission_key) do nothing;
insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p where r.role_key = 'owner' and p.permission_key = 'hr.approve_all_requests'
on conflict (role_id, permission_id) do nothing;

create table if not exists public.approval_modes (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    request_kind text not null check (request_kind in ('leave', 'permission', 'correction')),
    mode text not null default 'direct' check (mode in ('direct', 'decentralized', 'centralized', 'two_step')),
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (organization_id, request_kind)
);
alter table public.approval_modes enable row level security;
revoke all on public.approval_modes from anon, authenticated;

alter table public.leave_requests add column if not exists approval_step smallint not null default 1 check (approval_step in (1, 2));

create or replace function public.prosm_time_approval_mode(p_org uuid, p_kind text)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select mode from approval_modes where organization_id = p_org and request_kind = p_kind), 'direct');
$$;
revoke all on function public.prosm_time_approval_mode(uuid, text) from public, anon, authenticated;

-- the operational side over a person: a site's manager (today's rule) or the manager of the person's department
create or replace function public.prosm_time_operational_over(p_actor uuid, p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select p_actor <> p_subject and (
        public.prosm_time_user_has_authority_over(p_actor, p_subject)
        or exists (select 1 from users s join departments d on d.id = s.department_id and d.organization_id = s.organization_id and d.is_active
                   where s.id = p_subject and d.manager_user_id = p_actor)
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
revoke all on function public.prosm_time_is_hr_approver(uuid) from public, anon, authenticated;

-- may p_actor decide p_subject's leave at p_step (1 = operational step, 2 = HR step of two_step)?
create or replace function public.prosm_time_leave_decider(p_actor uuid, p_subject uuid, p_step smallint default 1)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_mode text;
    v_base boolean;
    v_ops boolean;
    v_hr boolean;
begin
    if p_actor is null or p_subject is null or p_actor = p_subject then return false; end if;
    select a.organization_id into v_org from users a join users s on s.id = p_subject and s.organization_id = a.organization_id
    where a.id = p_actor and a.is_active;
    if v_org is null then return false; end if;
    -- the owner, a full deputy, or a deputy given leave approval (the owner's partial authority, 20261113235000)
    v_base := exists (select 1 from users where id = p_actor and is_owner) or public.prosm_time_is_owner_delegate(p_actor)
              or 'leave.approve' = any(public.prosm_time_delegated_permissions(p_actor));
    if v_base then return true; end if;
    v_hr := public.prosm_time_is_hr_approver(p_actor);
    v_ops := public.prosm_time_user_has_permission_internal(p_actor, 'leave.approve') and public.prosm_time_operational_over(p_actor, p_subject);
    v_mode := public.prosm_time_approval_mode(v_org, 'leave');
    return case v_mode
        when 'centralized' then v_hr
        when 'two_step' then case when p_step = 2 then v_hr else v_ops end
        else v_ops or v_hr
    end;
end;
$$;
revoke all on function public.prosm_time_leave_decider(uuid, uuid, smallint) from public, anon, authenticated;

-- is anybody operational over the person (else a two_step request starts at HR)?
create or replace function public.prosm_time_has_operational_manager(p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from users u where u.organization_id = (select organization_id from users where id = p_subject) and u.is_active
          and not u.is_owner and public.prosm_time_user_has_permission_internal(u.id, 'leave.approve') and public.prosm_time_operational_over(u.id, p_subject)
    );
$$;
revoke all on function public.prosm_time_has_operational_manager(uuid) from public, anon, authenticated;

-- the owner sets the mode (audited)
create or replace function public.set_prosm_time_approval_mode(p_kind text, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_old text;
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if not exists (select 1 from users where id = v_me and is_owner) then raise exception 'ONLY THE ORGANIZATION OWNER'; end if;
    if p_kind not in ('leave', 'permission', 'correction') or p_mode not in ('direct', 'decentralized', 'centralized', 'two_step') then
        raise exception 'INVALID REQUEST';
    end if;
    v_old := public.prosm_time_approval_mode(v_org, p_kind);
    insert into approval_modes (organization_id, request_kind, mode, updated_by) values (v_org, p_kind, p_mode, v_me)
    on conflict (organization_id, request_kind) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now();
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, 'APPROVAL_MODE_CHANGED', 'approval_modes', v_org, 'How requests are decided was changed',
            jsonb_build_object('kind', p_kind, 'mode', v_old), jsonb_build_object('kind', p_kind, 'mode', p_mode));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_approval_mode(text, text) from public, anon;
grant execute on function public.set_prosm_time_approval_mode(text, text) to authenticated;

create or replace function public.get_prosm_time_approval_modes()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'leave', public.prosm_time_approval_mode(public.current_prosm_time_organization_id(), 'leave'),
        'permission', public.prosm_time_approval_mode(public.current_prosm_time_organization_id(), 'permission'),
        'correction', public.prosm_time_approval_mode(public.current_prosm_time_organization_id(), 'correction'));
$$;
revoke all on function public.get_prosm_time_approval_modes() from public, anon;
grant execute on function public.get_prosm_time_approval_modes() to authenticated;

-- the decision: who may decide, and the two-step hand-over to HR ------------------------------------------------
do $$
declare
    v_def text;
    v_perm_old text := $q$    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;$q$;
    v_perm_new text := $q$    if not (public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') or public.prosm_time_is_hr_approver(v_caller_id)) then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;$q$;
    v_auth_old text := $q$if not public.prosm_time_caller_has_authority_over(v_request.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;$q$;
    v_auth_new text := $q$-- phase F: who decides follows the organisation's approval mode (direct = as before)
    if v_request.status = 'pending' and v_request.approval_step = 1 and public.prosm_time_approval_mode(v_org, 'leave') = 'two_step'
       and not public.prosm_time_has_operational_manager(v_request.user_id) then
        update leave_requests set approval_step = 2 where id = v_request.id;
        v_request.approval_step := 2;
    end if;
    if not public.prosm_time_leave_decider(v_caller_id, v_request.user_id, case when v_request.status = 'approved' then 2::smallint else v_request.approval_step end) then
        if v_request.approval_step = 2 and v_request.status = 'pending' then raise exception 'THIS REQUEST IS WAITING FOR HUMAN RESOURCES'; end if;
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;
    -- two_step: the operational approval hands the request to HR (unless the same person may also decide step 2)
    if p_action = 'approved' and v_request.status = 'pending' and v_request.approval_step = 1
       and public.prosm_time_approval_mode(v_org, 'leave') = 'two_step'
       and not public.prosm_time_leave_decider(v_caller_id, v_request.user_id, 2::smallint) then
        update leave_requests set approval_step = 2 where id = v_request.id;
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
        values (v_org, v_caller_id, v_request.user_id, 'leave.first_approval', 'leave_requests', v_request.id, 'Leave approved by the manager - waiting for human resources',
                nullif(trim(coalesce(p_notes, '')), ''));
        return jsonb_build_object('success', true, 'awaiting', 'hr');
    end if;$q$;
begin
    v_def := replace(pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text, numeric, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_leave_decider' in v_def) > 0 then return; end if;
    if position(v_perm_old in v_def) = 0 then raise exception 'review leave: permission anchor not found'; end if;
    if position(v_auth_old in v_def) = 0 then raise exception 'review leave: authority anchor not found'; end if;
    execute replace(replace(v_def, v_perm_old, v_perm_new), v_auth_old, v_auth_new);
end $$;

-- the pending list: what the caller may decide now
create or replace function public.list_prosm_time_pending_leave_requests()
 returns table(id uuid, user_id uuid, employee_name text, leave_type text, start_date date, end_date date, days_count numeric, reason text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') or public.prosm_time_is_hr_approver(v_caller_id)) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE LEAVE REVIEW QUEUE';
    end if;
    v_org := public.current_prosm_time_organization_id();
    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, lr.created_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    where lr.organization_id = v_org and lr.status = 'pending'
      and public.prosm_time_leave_decider(v_caller_id, lr.user_id,
            case when lr.approval_step = 1 and public.prosm_time_approval_mode(v_org, 'leave') = 'two_step'
                      and not public.prosm_time_has_operational_manager(lr.user_id) then 2::smallint else lr.approval_step end)
    order by lr.created_at asc;
end;
$function$;

-- "send the request to": who may decide its first step
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
           public.prosm_time_is_owner_delegate(u.id) or 'leave.approve' = any(public.prosm_time_delegated_permissions(u.id))
    from users u
    left join roles r on r.id = u.role_id
    where u.organization_id = (select organization_id from users where id = p_user_id)
      and u.is_active and u.id <> p_user_id
      and public.prosm_time_leave_decider(u.id, p_user_id,
            case when public.prosm_time_approval_mode(u.organization_id, 'leave') = 'two_step'
                      and not public.prosm_time_has_operational_manager(p_user_id) then 2::smallint else 1::smallint end);
$$;
revoke all on function public.prosm_time_leave_reviewers_for(uuid) from public, anon, authenticated;

commit;
