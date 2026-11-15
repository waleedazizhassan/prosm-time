-- Governance phase D (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md sections 8.2-8.5).
-- Workflow hardening on the existing request tables - no new engine, nothing renamed:
--   1. Payroll self-approval (8.3): whoever submitted a cycle does not approve it. The real owner, who has nobody
--      above, still may - but only when nobody else could approve that cycle (same scope rule as the approval
--      itself: a deputy, or a payroll.approve holder covering the cycle's site); it is then written to the
--      audit trail as PAYROLL_SELF_APPROVED. (Step-up for approving is phase C.)
--   2. One decision per request (8.4): deciding a leave request or an exception/correction now locks the request
--      row first (FOR UPDATE), so two managers deciding at the same moment cannot both pass the "still pending"
--      check - the second one sees the first one's decision.
--   3. One pending correction at a time for the same shift and the same clock event (a double tap or a resend
--      creates one request, not two); the check locks the shift row, so two simultaneous submissions serialise.
--   4. API keys (8.5-e): an expiry is required - 90 days when none is given, 365 at most. Keys without one get
--      created_at + 365 days (at least 30 days from today), and their owner sees it on the integrations page. The
--      key's hash, prefix and organisation never change, a revocation is never undone, and an expiry is only ever
--      brought forward. Rotating issues a new key with the same scopes and lets the old one run for 24 more hours.
--   6. A person's permissions go back to their role's defaults in one step (each change still governed).
--   5. Delegation (8.2): a new delegation of the owner's authority lasts at most 30 days (30 when no end is given);
--      the owner grants it again to extend. Delegations already running keep their dates.
-- Rollback: drop the triggers payroll_cycles_self_approval_audit, correction_requests_one_pending,
-- api_keys_guard, owner_delegations_window and their functions, drop column api_keys.replaced_by and function
-- rotate_prosm_time_api_key, re-run transition_prosm_time_payroll_cycle / review_prosm_time_leave /
-- review_prosm_time_exception / generate_prosm_time_api_key_v2 from before.

begin;

-- 1. Payroll self-approval ----------------------------------------------------------------------
-- someone else who could approve THIS cycle - the same rule as prosm_time_payroll_allows: a full deputy, a partial
-- deputy given payroll.approve, or a holder of payroll.approve whose managed sites (if any) include the cycle's site
-- (an organisation-wide cycle needs someone without a site limit)
create or replace function public.prosm_time_other_payroll_approver_exists(p_org uuid, p_caller uuid, p_site uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from users u
        where u.organization_id = p_org and u.is_active and u.id <> p_caller and not u.is_owner
          and (
              public.prosm_time_is_owner_delegate(u.id)
              or 'payroll.approve' = any(public.prosm_time_delegated_permissions(u.id))
              or (
                  public.prosm_time_user_has_permission_internal(u.id, 'payroll.approve')
                  and (
                      not exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
                      or (p_site is not null and exists (select 1 from site_assignments sa
                                                         where sa.user_id = u.id and sa.role_at_site = 'manager' and sa.site_id = p_site))
                  )
              )
          )
    );
$$;
revoke all on function public.prosm_time_other_payroll_approver_exists(uuid, uuid, uuid) from public, anon, authenticated;

do $$
declare
    v_def text;
    v_old text := 'if v_cycle.submitted_by = v_caller and not public.current_prosm_time_user_is_real_owner() then';
    v_new text := 'if v_cycle.submitted_by = v_caller and (not public.current_prosm_time_user_is_real_owner() or public.prosm_time_other_payroll_approver_exists(v_cycle.organization_id, v_caller, v_cycle.site_id)) then';
begin
    v_def := replace(pg_get_functiondef('public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(v_new in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'payroll self-approval: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

create or replace function public.prosm_time_payroll_self_approval_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.approved_at is distinct from old.approved_at and new.approved_by is not null and new.approved_by = new.submitted_by then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
        values (new.organization_id, new.approved_by, new.approved_by, 'PAYROLL_SELF_APPROVED', 'payroll_cycles', new.id,
                'The owner approved a payroll cycle they submitted themselves (nobody else holds payroll approval)',
                jsonb_build_object('cycleTitle', new.title, 'periodStart', new.period_start, 'periodEnd', new.period_end, 'cycleVersion', new.cycle_version));
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_self_approval_audit() from public, anon, authenticated;

drop trigger if exists payroll_cycles_self_approval_audit on public.payroll_cycles;
create trigger payroll_cycles_self_approval_audit after update of approved_at on public.payroll_cycles
    for each row execute function public.prosm_time_payroll_self_approval_audit();

-- 2. One decision per request -------------------------------------------------------------------
do $$
declare
    v_def text;
    v_count integer;
begin
    v_def := replace(pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text, numeric)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('from leave_requests where id = p_request_id and organization_id = v_org for update;' in v_def) = 0 then
        if position('select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;' in v_def) = 0 then
            raise exception 'review leave: anchor not found';
        end if;
        execute replace(v_def, 'select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;',
                               'select * into v_request from leave_requests where id = p_request_id and organization_id = v_org for update;');
    end if;

    v_def := replace(pg_get_functiondef('public.review_prosm_time_exception(text, uuid, text, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('where id = p_target_id and organization_id = v_caller_org for update;' in v_def) = 0 then
        v_count := (length(v_def) - length(replace(v_def, 'where id = p_target_id and organization_id = v_caller_org;', ''))) / length('where id = p_target_id and organization_id = v_caller_org;');
        if v_count = 0 then raise exception 'review exception: anchor not found'; end if;
        execute replace(v_def, 'where id = p_target_id and organization_id = v_caller_org;', 'where id = p_target_id and organization_id = v_caller_org for update;');
    end if;
end $$;

-- 3. One pending correction for the same shift and event ---------------------------------------
create or replace function public.prosm_time_one_pending_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status = 'pending' then
        perform 1 from attendance_sessions where id = new.attendance_session_id for update;
        if exists (select 1 from correction_requests
                   where attendance_session_id = new.attendance_session_id and proposed_event_type = new.proposed_event_type
                     and status = 'pending' and id <> new.id) then
            raise exception 'A CORRECTION FOR THIS IS ALREADY PENDING';
        end if;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_one_pending_correction() from public, anon, authenticated;

drop trigger if exists correction_requests_one_pending on public.correction_requests;
create trigger correction_requests_one_pending before insert on public.correction_requests
    for each row execute function public.prosm_time_one_pending_correction();

-- 4. API keys: a required expiry, an immutable identity, rotation ------------------------------
alter table public.api_keys add column if not exists replaced_by uuid references public.api_keys(id) on delete set null;

update public.api_keys set expires_at = greatest(created_at + interval '365 days', now() + interval '30 days')
where expires_at is null and revoked_at is null;

create or replace function public.prosm_time_api_key_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        new.expires_at := coalesce(new.expires_at, now() + interval '90 days');
        if new.expires_at <= now() then raise exception 'THE EXPIRY MUST BE IN THE FUTURE'; end if;
        if new.expires_at > now() + interval '365 days' then raise exception 'AN API KEY LASTS AT MOST 365 DAYS'; end if;
        return new;
    end if;
    if new.key_hash is distinct from old.key_hash or new.key_prefix is distinct from old.key_prefix
       or new.organization_id is distinct from old.organization_id or new.created_at is distinct from old.created_at then
        raise exception 'AN API KEY CANNOT BE CHANGED - CREATE A NEW ONE';
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
        raise exception 'A REVOKED API KEY STAYS REVOKED';
    end if;
    if old.expires_at is not null and (new.expires_at is null or new.expires_at > old.expires_at) then
        raise exception 'AN API KEY''S EXPIRY IS NEVER EXTENDED - ROTATE IT';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_api_key_guard() from public, anon, authenticated;

drop trigger if exists api_keys_guard on public.api_keys;
create trigger api_keys_guard before insert or update on public.api_keys
    for each row execute function public.prosm_time_api_key_guard();

create or replace function public.rotate_prosm_time_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_old api_keys%rowtype;
    v_plain text;
    v_id uuid;
    v_lifetime interval;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY CREATE AN API KEY'; end if;
    perform public.prosm_time_require_step_up('apikey.create');
    if not public.prosm_time_api_enabled(v_org) then raise exception 'FEATURE NOT IN PLAN: integrations'; end if;
    select * into v_old from api_keys where id = p_key_id and organization_id = v_org for update;
    if v_old.id is null then raise exception 'API KEY NOT FOUND'; end if;
    if v_old.revoked_at is not null or (v_old.expires_at is not null and v_old.expires_at <= now()) or v_old.replaced_by is not null then
        raise exception 'ONLY AN ACTIVE KEY IS ROTATED';
    end if;

    v_lifetime := least(coalesce(v_old.expires_at - v_old.created_at, interval '90 days'), interval '365 days');
    if v_lifetime < interval '1 day' then v_lifetime := interval '90 days'; end if;
    v_plain := 'ptime_' || v_old.environment || '_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into api_keys (organization_id, name, key_hash, key_prefix, scope, scopes, expires_at, environment, created_by)
    values (v_org, v_old.name, encode(sha256(convert_to(v_plain, 'utf8')), 'hex'), substring(v_plain, 1, 18), v_old.scope, v_old.scopes,
            now() + v_lifetime, v_old.environment, v_caller)
    returning id into v_id;
    -- the old key keeps working for 24 hours (or until its own expiry, if sooner), then the clock ends it
    update api_keys set expires_at = least(coalesce(expires_at, now() + interval '24 hours'), now() + interval '24 hours'), replaced_by = v_id
    where id = v_old.id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_caller, 'API_KEY_ROTATED', 'api_keys', v_id, 'Rotated an API key - the old one stops within 24 hours',
            jsonb_build_object('oldKeyId', v_old.id, 'newKeyId', v_id, 'scopes', to_jsonb(v_old.scopes)));
    return jsonb_build_object('success', true, 'keyId', v_id, 'apiKey', v_plain, 'oldKeyEndsAt', now() + interval '24 hours');
end;
$$;
revoke all on function public.rotate_prosm_time_api_key(uuid) from public, anon;
grant execute on function public.rotate_prosm_time_api_key(uuid) to authenticated;

-- the list shows a rotated key as replaced
do $$
declare
    v_def text;
begin
    v_def := replace(pg_get_functiondef('public.list_prosm_time_api_keys()'::regprocedure), chr(13) || chr(10), chr(10));
    if position('''replacedBy''' in v_def) > 0 then return; end if;
    if position('''revokedAt'', k.revoked_at,' in v_def) = 0 then raise exception 'list api keys: anchor not found'; end if;
    execute replace(v_def, '''revokedAt'', k.revoked_at,', '''revokedAt'', k.revoked_at, ''replacedBy'', k.replaced_by,');
end $$;

-- 5. A delegation lasts at most 30 days --------------------------------------------------------
create or replace function public.prosm_time_delegation_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.ends_at := coalesce(new.ends_at, new.starts_at + interval '30 days');
    if new.ends_at > new.starts_at + interval '30 days' then
        raise exception 'A DELEGATION LASTS AT MOST 30 DAYS - GRANT IT AGAIN TO EXTEND';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_delegation_window() from public, anon, authenticated;

drop trigger if exists owner_delegations_window on public.owner_delegations;
create trigger owner_delegations_window before insert on public.owner_delegations
    for each row execute function public.prosm_time_delegation_window();

-- 6. Back to the role's defaults (owner 2026-11-15) -------------------------------------------
-- every individual grant or removal of one person cleared in one step; each one goes through
-- clear_prosm_time_user_permission_override, so the governance rules (nobody changes their own permissions, only
-- someone of a higher rank, a permission given back only by someone who holds it) apply to each - all or nothing.
create or replace function public.reset_prosm_time_user_permissions(p_target_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key text;
    v_count integer := 0;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if not exists (select 1 from users where id = p_target_user_id and organization_id = public.current_prosm_time_organization_id()) then
        raise exception 'USER NOT FOUND';
    end if;
    for v_key in
        select p.permission_key from user_permission_overrides upo join permissions p on p.id = upo.permission_id
        where upo.user_id = p_target_user_id order by p.permission_key
    loop
        perform public.clear_prosm_time_user_permission_override(p_target_user_id, v_key, trim(p_reason));
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'cleared', v_count);
end;
$$;
revoke all on function public.reset_prosm_time_user_permissions(uuid, text) from public, anon;
grant execute on function public.reset_prosm_time_user_permissions(uuid, text) to authenticated;

commit;
