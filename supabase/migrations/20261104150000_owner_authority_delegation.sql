-- Owner 2026-11-04: "Grant permissions" - the owner can give any person ALL of the owner's
-- authority (every permission, every owner-only action, and every notification and email the
-- owner receives), without touching the owner's own. Withdrawing it puts everything back: the
-- person returns to their role and their own permissions, as governance defines them.
-- Part of governance: every grant and withdrawal has a reason, is in the action log, and the
-- person is told.
--
-- How: current_prosm_time_user_is_owner() - the check behind 132 owner-only rules - now means
-- "has the owner's authority" (the owner, or a person holding it). Where it means the owner as
-- a person ("the owner does not clock in", "the owner has no allowances"), the rule now asks
-- current_prosm_time_user_is_real_owner(), so the delegate still clocks in and has allowances.

create table if not exists public.owner_delegations (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    granted_by uuid references public.users(id) on delete set null,
    reason text not null,
    granted_at timestamptz not null default now(),
    revoked_at timestamptz,
    revoked_by uuid references public.users(id) on delete set null,
    revoke_reason text
);
create unique index if not exists owner_delegations_one_active on public.owner_delegations (user_id) where revoked_at is null;
create index if not exists owner_delegations_org_idx on public.owner_delegations (organization_id);

alter table public.owner_delegations enable row level security;
drop policy if exists owner_delegations_read on public.owner_delegations;
create policy owner_delegations_read on public.owner_delegations for select to authenticated
    using (organization_id = public.current_prosm_time_organization_id());
revoke insert, update, delete on public.owner_delegations from anon, authenticated;

-- Holds the owner's authority now (active person, same organisation, grant not withdrawn).
create or replace function public.prosm_time_is_owner_delegate(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from owner_delegations d join users u on u.id = d.user_id
        where d.user_id = p_user and d.revoked_at is null and u.is_active and not u.is_owner
          and u.organization_id = d.organization_id
    );
$$;
revoke all on function public.prosm_time_is_owner_delegate(uuid) from public, anon;
grant execute on function public.prosm_time_is_owner_delegate(uuid) to authenticated, service_role;

-- The owner as a person.
create or replace function public.current_prosm_time_user_is_real_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select is_owner from public.users where auth_user_id = auth.uid()), false);
$$;
revoke all on function public.current_prosm_time_user_is_real_owner() from public, anon;
grant execute on function public.current_prosm_time_user_is_real_owner() to authenticated, service_role;

-- The owner's authority: the owner, or a person holding it.
create or replace function public.current_prosm_time_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select u.is_owner or public.prosm_time_is_owner_delegate(u.id)
        from public.users u where u.auth_user_id = auth.uid()
    ), false);
$$;

-- A person with the owner's authority has every permission.
create or replace function public.prosm_time_user_has_permission_internal(p_user_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
    select
        exists (select 1 from users where id = p_user_id and is_owner = true)
        or public.prosm_time_is_owner_delegate(p_user_id)
        or p_permission_key = any(coalesce((
            select array_agg(distinct permission_key) from (
                select p.permission_key
                from role_default_permissions rdp
                join permissions p on p.id = rdp.permission_id
                join users u on u.role_id = rdp.role_id
                where u.id = p_user_id
                union
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = true
                except
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = false
            ) effective
        ), array[]::text[]));
$function$;

-- The rules that mean the owner as a person keep meaning only the owner; the effective
-- permissions list every permission for a person holding the owner's authority.
do $patch$
declare
    v_fn record;
    v_def text;
    v_new text;
    v_count integer := 0;
begin
    for v_fn in
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.prosrc ~ 'if public\.current_prosm_time_user_is_owner\(\) then\s+raise exception ''THE OWNER'
               or p.prosrc like '%v_caller_is_owner := public.current_prosm_time_user_is_owner();%')
    loop
        v_def := pg_get_functiondef(v_fn.oid);
        v_new := regexp_replace(v_def, 'if public\.current_prosm_time_user_is_owner\(\) then(\s+)raise exception ''THE OWNER', 'if public.current_prosm_time_user_is_real_owner() then\1raise exception ''THE OWNER', 'g');
        v_new := replace(v_new, 'v_caller_is_owner := public.current_prosm_time_user_is_owner();', 'v_caller_is_owner := public.current_prosm_time_user_is_real_owner();');
        if v_new <> v_def then
            execute v_new;
            v_count := v_count + 1;
        end if;
    end loop;
    if v_count < 4 then
        raise exception 'expected the owner-as-a-person rules, found %', v_count;
    end if;

    v_def := pg_get_functiondef('public.get_prosm_time_effective_permissions(uuid)'::regprocedure);
    if position('    return (
        select array_agg(distinct permission_key) from (' in v_def) = 0 then
        raise exception 'effective permissions: return not found';
    end if;
    v_def := replace(v_def, '    return (
        select array_agg(distinct permission_key) from (', '    -- owner 2026-11-04: the owner''s authority brings every permission
    if public.prosm_time_is_owner_delegate(v_target_id) then
        return (select array_agg(p.permission_key order by p.permission_key) from permissions p);
    end if;

    return (
        select array_agg(distinct permission_key) from (');
    execute v_def;
end;
$patch$;

-- The notification types of the grant and its withdrawal.
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if position('owner_authority_granted' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''owner_authority_granted''::text, ''owner_authority_revoked''::text');
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- Everything that reaches the owner reaches the people holding the owner's authority too -
-- the notification, its push and its email (the emails go to a notification's person).
create or replace function public.prosm_time_copy_owner_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_delegate uuid;
begin
    if coalesce(new.data ->> 'ownerCopyOf', '') <> '' or new.type in ('owner_authority_granted', 'owner_authority_revoked') then
        return new;
    end if;
    if not exists (select 1 from users where id = new.user_id and is_owner) then
        return new;
    end if;
    for v_delegate in
        select d.user_id from owner_delegations d join users u on u.id = d.user_id
        where d.organization_id = new.organization_id and d.revoked_at is null and u.is_active and not u.is_owner
    loop
        insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
        values (new.organization_id, v_delegate, new.type, new.priority, new.title, new.body, new.related_entity_type, new.related_entity_id,
                coalesce(new.data, '{}'::jsonb) || jsonb_build_object('ownerCopyOf', new.id));
    end loop;
    return new;
exception when others then
    -- never let a copy block the owner's own notification
    return new;
end;
$$;

drop trigger if exists notifications_copy_to_owner_delegates on public.notifications;
create trigger notifications_copy_to_owner_delegates
    after insert on public.notifications
    for each row execute function public.prosm_time_copy_owner_notification();

-- Grant: the owner only (not a person holding the authority), with a reason.
create or replace function public.grant_prosm_time_owner_authority(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_target users%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_id uuid;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE OWNER GRANTS THE OWNER''S AUTHORITY'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    select * into v_target from users where id = p_user_id and organization_id = v_org;
    if v_target.id is null then raise exception 'USER NOT FOUND'; end if;
    if v_target.is_owner then raise exception 'THE OWNER ALREADY HAS IT'; end if;
    if not v_target.is_active then raise exception 'THIS PERSON IS NOT ACTIVE'; end if;
    if exists (select 1 from owner_delegations where user_id = p_user_id and revoked_at is null) then
        raise exception 'THIS PERSON ALREADY HAS THE OWNER''S AUTHORITY';
    end if;

    insert into owner_delegations (organization_id, user_id, granted_by, reason)
    values (v_org, p_user_id, v_caller, left(v_reason, 500))
    returning id into v_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (v_org, v_caller, p_user_id, 'OWNER_AUTHORITY_GRANTED', 'owner_delegations', v_id,
            'The owner''s full authority was granted to ' || v_target.full_name || '.', v_reason, jsonb_build_object('reason', v_reason));

    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'owner_authority_granted', 'high', 'You have the owner''s authority',
        'The owner gave you all of the owner''s permissions, notifications and emails until they withdraw it.',
        'owner_delegations', v_id, jsonb_build_object('reason', v_reason));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.grant_prosm_time_owner_authority(uuid, text) from public, anon;
grant execute on function public.grant_prosm_time_owner_authority(uuid, text) to authenticated;

-- Withdraw: the owner only, with a reason; the person is back to their own permissions at once.
create or replace function public.revoke_prosm_time_owner_authority(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_row owner_delegations%rowtype;
    v_name text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE OWNER GRANTS THE OWNER''S AUTHORITY'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    update owner_delegations set revoked_at = now(), revoked_by = v_caller, revoke_reason = left(v_reason, 500)
    where user_id = p_user_id and organization_id = v_org and revoked_at is null
    returning * into v_row;
    if v_row.id is null then raise exception 'THIS PERSON DOES NOT HAVE THE OWNER''S AUTHORITY'; end if;
    select full_name into v_name from users where id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (v_org, v_caller, p_user_id, 'OWNER_AUTHORITY_REVOKED', 'owner_delegations', v_row.id,
            'The owner''s authority was withdrawn from ' || coalesce(v_name, '') || '.', v_reason, jsonb_build_object('reason', v_reason));

    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'owner_authority_revoked', 'normal', 'The owner''s authority was withdrawn',
        'You are back to your own role and permissions.', 'owner_delegations', v_row.id, jsonb_build_object('reason', v_reason));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.revoke_prosm_time_owner_authority(uuid, text) from public, anon;
grant execute on function public.revoke_prosm_time_owner_authority(uuid, text) to authenticated;

-- The signed-in person's own standing: the app shows the owner's screens to a delegate.
create or replace function public.get_prosm_time_my_owner_authority()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'delegate', public.prosm_time_is_owner_delegate(u.id),
        'grantedAt', (select d.granted_at from owner_delegations d where d.user_id = u.id and d.revoked_at is null),
        'grantedBy', (select o.full_name from owner_delegations d join users o on o.id = d.granted_by where d.user_id = u.id and d.revoked_at is null))
    from users u where u.auth_user_id = auth.uid();
$$;
revoke all on function public.get_prosm_time_my_owner_authority() from public, anon;
grant execute on function public.get_prosm_time_my_owner_authority() to authenticated;
