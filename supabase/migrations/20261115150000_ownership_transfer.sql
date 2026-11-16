-- Governance phase E (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md section 8.5-f).
-- Ownership transfer, the only path that changes who the owner is:
--   start (the real owner, with a recent sign-in) -> accept (the recipient, an active member, with a recent
--   sign-in) -> 72 hours of waiting, every manager told -> complete (either of them, once the wait is over).
--   The owner may cancel until it completes. One open transfer per organisation. Never delegated: a deputy is
--   refused at every step.
-- Completing is done by prosm_time_complete_ownership_switch, owned by the NOLOGIN role prosm_ownership_admin
-- (20261115100000): the users trigger lets that role, and no other, move is_owner. Nobody is a member of the role,
-- and current_user inside a SECURITY DEFINER function cannot be set by the caller.
-- On completion: the new owner takes the owner role and is_owner, the previous owner becomes a manager, every
-- delegation of the owner's authority ends, and the audit trail records it.
-- Recovery when every owner is lost stays a manual platform procedure (proof of identity and company papers
-- outside the app, a waiting period, notices) - documented, not built.
-- Rollback: drop table ownership_transfers and the functions below; drop the policies/grants given to
-- prosm_ownership_admin.

begin;

create table if not exists public.ownership_transfers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    from_user_id uuid not null references public.users(id) on delete cascade,
    to_user_id uuid not null references public.users(id) on delete cascade,
    reason text not null check (length(trim(reason)) between 1 and 500),
    state text not null default 'initiated' check (state in ('initiated', 'accepted', 'completed', 'cancelled')),
    created_at timestamptz not null default now(),
    accepted_at timestamptz,
    cooling_until timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    cancelled_by uuid references public.users(id) on delete set null,
    check (from_user_id <> to_user_id),
    check (state <> 'accepted' or (accepted_at is not null and cooling_until is not null)),
    check (state <> 'completed' or completed_at is not null)
);
create unique index if not exists ownership_transfers_one_open on public.ownership_transfers (organization_id) where state in ('initiated', 'accepted');
alter table public.ownership_transfers enable row level security;
revoke all on public.ownership_transfers from anon, authenticated;
-- read through get_prosm_time_ownership_transfer

-- the switch itself, run as prosm_ownership_admin ----------------------------------------------
do $$
begin
    -- the migration role must be able to hand the function to the role (PostgreSQL 16+: SET on the role)
    execute 'grant prosm_ownership_admin to current_user';
exception when others then
    null; -- already a member, or the owner is a superuser (tests)
end $$;

grant usage on schema public to prosm_ownership_admin;
-- the other triggers on users run with the switch's identity: the role may read and run what they use. It cannot log
-- in and no role is a member of it; its one function is the switch below.
grant select on all tables in schema public to prosm_ownership_admin;
grant execute on all functions in schema public to prosm_ownership_admin;
alter default privileges in schema public grant execute on functions to prosm_ownership_admin;
alter default privileges in schema public grant select on tables to prosm_ownership_admin;
grant select, update on public.users to prosm_ownership_admin;
grant select on public.roles, public.organizations to prosm_ownership_admin;
grant select, update on public.owner_delegations to prosm_ownership_admin;
grant select, update on public.ownership_transfers to prosm_ownership_admin;
grant insert on public.audit_logs to prosm_ownership_admin;
drop policy if exists ownership_admin_users on public.users;
create policy ownership_admin_users on public.users for all to prosm_ownership_admin using (true) with check (true);
drop policy if exists ownership_admin_delegations on public.owner_delegations;
create policy ownership_admin_delegations on public.owner_delegations for all to prosm_ownership_admin using (true) with check (true);
drop policy if exists ownership_admin_transfers on public.ownership_transfers;
create policy ownership_admin_transfers on public.ownership_transfers for all to prosm_ownership_admin using (true) with check (true);
drop policy if exists ownership_admin_audit on public.audit_logs;
create policy ownership_admin_audit on public.audit_logs for insert to prosm_ownership_admin with check (true);
drop policy if exists ownership_admin_roles on public.roles;
create policy ownership_admin_roles on public.roles for select to prosm_ownership_admin using (true);
drop policy if exists ownership_admin_orgs on public.organizations;
create policy ownership_admin_orgs on public.organizations for select to prosm_ownership_admin using (true);

create or replace function public.prosm_time_complete_ownership_switch(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_t ownership_transfers%rowtype;
    v_owner_role uuid;
    v_manager_role uuid;
begin
    select * into v_t from ownership_transfers where id = p_transfer_id for update;
    if v_t.id is null or v_t.state <> 'accepted' or v_t.cooling_until > now() then
        raise exception 'THE OWNERSHIP TRANSFER IS NOT READY';
    end if;
    select id into v_owner_role from roles where role_key = 'owner';
    select id into v_manager_role from roles where role_key = 'manager';
    -- the unique "one owner" index: the old owner steps down first, in the same transaction
    update users set is_owner = false, role_id = v_manager_role, updated_at = now()
    where id = v_t.from_user_id and organization_id = v_t.organization_id and is_owner;
    if not found then raise exception 'THE OWNERSHIP TRANSFER IS NOT READY'; end if;
    update users set is_owner = true, role_id = v_owner_role, updated_at = now()
    where id = v_t.to_user_id and organization_id = v_t.organization_id and is_active;
    if not found then raise exception 'THE RECIPIENT IS NO LONGER AN ACTIVE MEMBER'; end if;
    update owner_delegations set revoked_at = now(), revoke_reason = 'ownership transferred'
    where organization_id = v_t.organization_id and revoked_at is null;
    update ownership_transfers set state = 'completed', completed_at = now() where id = v_t.id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_t.organization_id, v_t.from_user_id, v_t.to_user_id, 'OWNERSHIP_TRANSFERRED', 'ownership_transfers', v_t.id,
            'The organisation''s ownership was transferred', v_t.reason,
            jsonb_build_object('ownerUserId', v_t.from_user_id), jsonb_build_object('ownerUserId', v_t.to_user_id));
end;
$$;
-- handing a function to a role needs that role to hold CREATE on the schema (a superuser skips the check, so the
-- in-memory tests did not show it; found on a Supabase-like role set-up, 2026-11-15). Granted for the hand-over only.
grant create on schema public to prosm_ownership_admin;
alter function public.prosm_time_complete_ownership_switch(uuid) owner to prosm_ownership_admin;
revoke create on schema public from prosm_ownership_admin;
revoke all on function public.prosm_time_complete_ownership_switch(uuid) from public, anon, authenticated, service_role;
grant execute on function public.prosm_time_complete_ownership_switch(uuid) to postgres;

-- the notification type
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('ownership_transfer' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''ownership_transfer''::text');
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- the steps people take ---------------------------------------------------------------------------
create or replace function public.prosm_time_notify_ownership(p_org uuid, p_title text, p_body text, p_transfer uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user uuid;
begin
    for v_user in
        select u.id from users u join roles r on r.id = u.role_id
        where u.organization_id = p_org and u.is_active and (u.is_owner or r.role_key = 'manager')
    loop
        perform public.create_prosm_time_notification(p_org, v_user, 'ownership_transfer', 'high', p_title, p_body,
                                                      'ownership_transfers', p_transfer, jsonb_build_object('kind', 'ownership'));
    end loop;
exception when others then
    null; -- a notification never blocks the transfer itself
end;
$$;
revoke all on function public.prosm_time_notify_ownership(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.start_prosm_time_ownership_transfer(p_to_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE OWNER TRANSFERS THE OWNERSHIP'; end if;
    perform public.prosm_time_require_step_up('ownership.transfer');
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if not exists (select 1 from users where id = p_to_user_id and organization_id = v_org and is_active and not is_owner) then
        raise exception 'CHOOSE AN ACTIVE MEMBER OF THE ORGANIZATION';
    end if;
    insert into ownership_transfers (organization_id, from_user_id, to_user_id, reason)
    values (v_org, v_me, p_to_user_id, trim(p_reason)) returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_org, v_me, p_to_user_id, 'OWNERSHIP_TRANSFER_STARTED', 'ownership_transfers', v_id, 'An ownership transfer was started', trim(p_reason));
    perform public.prosm_time_notify_ownership(v_org, 'Ownership transfer started', 'The owner started transferring the organisation''s ownership.', v_id);
    return jsonb_build_object('success', true, 'transferId', v_id);
exception when unique_violation then
    raise exception 'AN OWNERSHIP TRANSFER IS ALREADY OPEN';
end;
$$;
revoke all on function public.start_prosm_time_ownership_transfer(uuid, text) from public, anon;
grant execute on function public.start_prosm_time_ownership_transfer(uuid, text) to authenticated;

create or replace function public.accept_prosm_time_ownership_transfer(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_t ownership_transfers%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_t from ownership_transfers where id = p_transfer_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_t.id is null or v_t.to_user_id <> v_me then raise exception 'OWNERSHIP TRANSFER NOT FOUND'; end if;
    if v_t.state <> 'initiated' then raise exception 'THIS OWNERSHIP TRANSFER IS NOT WAITING FOR YOU'; end if;
    perform public.prosm_time_require_step_up('ownership.accept');
    update ownership_transfers set state = 'accepted', accepted_at = now(), cooling_until = now() + interval '72 hours' where id = v_t.id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_t.organization_id, v_me, v_me, 'OWNERSHIP_TRANSFER_ACCEPTED', 'ownership_transfers', v_t.id, 'The recipient accepted the ownership transfer');
    perform public.prosm_time_notify_ownership(v_t.organization_id, 'Ownership transfer accepted',
        'The ownership moves in 72 hours unless the owner cancels it.', v_t.id);
    return jsonb_build_object('success', true, 'coolingUntil', now() + interval '72 hours');
end;
$$;
revoke all on function public.accept_prosm_time_ownership_transfer(uuid) from public, anon;
grant execute on function public.accept_prosm_time_ownership_transfer(uuid) to authenticated;

create or replace function public.cancel_prosm_time_ownership_transfer(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_t ownership_transfers%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_t from ownership_transfers where id = p_transfer_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_t.id is null or (v_me <> v_t.from_user_id and v_me <> v_t.to_user_id) then raise exception 'OWNERSHIP TRANSFER NOT FOUND'; end if;
    if v_me = v_t.from_user_id and not public.current_prosm_time_user_is_real_owner() then raise exception 'OWNERSHIP TRANSFER NOT FOUND'; end if;
    if v_t.state not in ('initiated', 'accepted') then raise exception 'THIS OWNERSHIP TRANSFER IS ALREADY CLOSED'; end if;
    update ownership_transfers set state = 'cancelled', cancelled_at = now(), cancelled_by = v_me where id = v_t.id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_t.organization_id, v_me, v_t.to_user_id, 'OWNERSHIP_TRANSFER_CANCELLED', 'ownership_transfers', v_t.id, 'The ownership transfer was cancelled');
    perform public.prosm_time_notify_ownership(v_t.organization_id, 'Ownership transfer cancelled', 'The ownership transfer was cancelled.', v_t.id);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.cancel_prosm_time_ownership_transfer(uuid) from public, anon;
grant execute on function public.cancel_prosm_time_ownership_transfer(uuid) to authenticated;

create or replace function public.complete_prosm_time_ownership_transfer(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_t ownership_transfers%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_t from ownership_transfers where id = p_transfer_id and organization_id = public.current_prosm_time_organization_id();
    if v_t.id is null or (v_me <> v_t.from_user_id and v_me <> v_t.to_user_id) then raise exception 'OWNERSHIP TRANSFER NOT FOUND'; end if;
    if v_me = v_t.from_user_id and not public.current_prosm_time_user_is_real_owner() then raise exception 'OWNERSHIP TRANSFER NOT FOUND'; end if;
    if v_t.state <> 'accepted' then raise exception 'THE OWNERSHIP TRANSFER IS NOT READY'; end if;
    if v_t.cooling_until > now() then raise exception 'THE WAITING PERIOD IS NOT OVER YET'; end if;
    perform public.prosm_time_complete_ownership_switch(v_t.id);
    perform public.prosm_time_notify_ownership(v_t.organization_id, 'Ownership transferred', 'The organisation has a new owner.', v_t.id);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.complete_prosm_time_ownership_transfer(uuid) from public, anon;
grant execute on function public.complete_prosm_time_ownership_transfer(uuid) to authenticated;

create or replace function public.get_prosm_time_ownership_transfer()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select jsonb_build_object('id', t.id, 'state', t.state, 'fromUserId', t.from_user_id, 'toUserId', t.to_user_id,
                                  'toName', u.full_name, 'fromName', f.full_name, 'reason', t.reason, 'createdAt', t.created_at,
                                  'acceptedAt', t.accepted_at, 'coolingUntil', t.cooling_until)
        from ownership_transfers t join users u on u.id = t.to_user_id join users f on f.id = t.from_user_id
        where t.organization_id = public.current_prosm_time_organization_id() and t.state in ('initiated', 'accepted')
          and public.current_prosm_time_user_id() in (t.from_user_id, t.to_user_id)
        limit 1
    ), 'null'::jsonb);
$$;
revoke all on function public.get_prosm_time_ownership_transfer() from public, anon;
grant execute on function public.get_prosm_time_ownership_transfer() to authenticated;

commit;
