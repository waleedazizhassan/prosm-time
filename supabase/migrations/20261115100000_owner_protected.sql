-- Governance phase A (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md section 14.4).
-- The real owner is protected on every path, not in two functions:
--   1. one guard, called first by every function that acts on a person: the owner is never its target
--      (a full deputy acts as the owner, never on the owner);
--   2. a trigger on users: nobody - service_role, a cron job or the table owner included - deactivates,
--      demotes, moves, un-owns or deletes the owner, or makes someone else owner. The organisation's own
--      deletion still removes its owner (the organisation row is already gone then). The owner's e-mail
--      changes only by the owner or by a platform path without a user session (the licence sync);
--   3. triggers on the tables tied to a person: no permission override on the owner, and nobody but the
--      owner changes the owner's devices.
-- No session setting opens any of this. The one future exception is the ownership transfer (phase E): a
-- function owned by the NOLOGIN role prosm_ownership_admin, which no role is a member of - the trigger
-- checks current_user, which a caller cannot set.
-- Rollback: drop the triggers users_protect_owner, user_permission_overrides_protect_owner,
-- device_bindings_protect_owner and their functions, re-run the patched function bodies from
-- 20260903150000 / 20260903160000 / 20260901160000 / 20261020190000, drop prosm_time_guard_owner_target.

begin;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'prosm_ownership_admin') then
        create role prosm_ownership_admin nologin noinherit;
    end if;
end $$;

-- 1. The guard ---------------------------------------------------------------------------------
create or replace function public.prosm_time_guard_owner_target(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if exists (select 1 from users where id = p_user_id and is_owner) then
        raise exception 'THE OWNER''S ACCOUNT IS PROTECTED';
    end if;
end;
$$;
revoke all on function public.prosm_time_guard_owner_target(uuid) from public, anon, authenticated;

-- every function that acts on a person calls it first
do $$
declare
    v_fn regprocedure;
    v_def text;
    v_anchor text := E'\nbegin\n';
begin
    foreach v_fn in array array[
        'public.deactivate_prosm_time_employee(uuid, text)'::regprocedure,
        'public.reactivate_prosm_time_employee(uuid)'::regprocedure,
        'public.authorize_prosm_time_employee_removal(uuid)'::regprocedure,
        'public.remove_prosm_time_employee(uuid, uuid, text)'::regprocedure,
        'public.authorize_prosm_time_employee_data_deletion_unchecked(uuid)'::regprocedure,
        'public.delete_prosm_time_employee_data(uuid, uuid, text)'::regprocedure
    ] loop
        v_def := replace(pg_get_functiondef(v_fn), chr(13) || chr(10), chr(10));
        if position('prosm_time_guard_owner_target' in v_def) > 0 then continue; end if;
        if position(v_anchor in v_def) = 0 then raise exception 'owner guard: anchor not found in %', v_fn; end if;
        v_def := overlay(v_def placing v_anchor || E'    perform public.prosm_time_guard_owner_target(p_user_id);\n'
                         from position(v_anchor in v_def) for length(v_anchor));
        execute v_def;
    end loop;
end $$;

-- 2. The owner's row ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user must be the real writer (a definer trigger would always see its owner),
-- so only a function owned by prosm_ownership_admin passes the first check.
create or replace function public.prosm_time_protect_owner_row()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    if current_user = 'prosm_ownership_admin' then
        return coalesce(new, old);
    end if;

    if tg_op = 'DELETE' then
        -- the organisation's own deletion cascades here once its row is gone
        if old.is_owner and exists (select 1 from organizations where id = old.organization_id) then
            raise exception 'THE OWNER''S ACCOUNT IS PROTECTED';
        end if;
        return old;
    end if;

    if new.is_owner is distinct from old.is_owner then
        raise exception 'THE OWNER CHANGES ONLY THROUGH AN OWNERSHIP TRANSFER';
    end if;

    if old.is_owner then
        if new.is_active is distinct from old.is_active
           or new.role_id is distinct from old.role_id
           or new.organization_id is distinct from old.organization_id
           or new.auth_user_id is distinct from old.auth_user_id
           or new.status is distinct from old.status
           or new.deactivated_at is distinct from old.deactivated_at
           or new.deactivated_by is distinct from old.deactivated_by
           or new.deactivation_reason is distinct from old.deactivation_reason then
            raise exception 'THE OWNER''S ACCOUNT IS PROTECTED';
        end if;
        -- the e-mail: the owner, or a platform path with no user session (the licence sync)
        if new.email is distinct from old.email
           and auth.uid() is distinct from old.auth_user_id
           and coalesce(auth.role(), '') not in ('', 'service_role') then
            raise exception 'THE OWNER''S ACCOUNT IS PROTECTED';
        end if;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_protect_owner_row() from public, anon, authenticated;

drop trigger if exists users_protect_owner on public.users;
create trigger users_protect_owner
    before update or delete on public.users
    for each row execute function public.prosm_time_protect_owner_row();

-- 3. The tables tied to a person ---------------------------------------------------------------
create or replace function public.prosm_time_protect_owner_override()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (select 1 from users where id = new.user_id and is_owner) then
        raise exception 'THE OWNER''S AUTHORITY CANNOT BE OVERRIDDEN';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_protect_owner_override() from public, anon, authenticated;

drop trigger if exists user_permission_overrides_protect_owner on public.user_permission_overrides;
create trigger user_permission_overrides_protect_owner
    before insert or update on public.user_permission_overrides
    for each row execute function public.prosm_time_protect_owner_override();

create or replace function public.prosm_time_protect_owner_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner_auth uuid;
begin
    select auth_user_id into v_owner_auth from users where id = old.user_id and is_owner;
    -- a signed-in person other than the owner (a deputy, a manager) never changes the owner's devices
    if v_owner_auth is not null and coalesce(auth.role(), '') = 'authenticated' and auth.uid() is distinct from v_owner_auth then
        raise exception 'THE OWNER''S ACCOUNT IS PROTECTED';
    end if;
    return coalesce(new, old);
end;
$$;
revoke all on function public.prosm_time_protect_owner_device() from public, anon, authenticated;

drop trigger if exists device_bindings_protect_owner on public.device_bindings;
create trigger device_bindings_protect_owner
    before update or delete on public.device_bindings
    for each row execute function public.prosm_time_protect_owner_device();

commit;
