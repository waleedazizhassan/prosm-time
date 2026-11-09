-- Owner 2026-11-08: delegation with limits.
--   * The owner can delegate their authority to a person (for example while on leave): from a
--     start date, until an end date or until withdrawn, all of it ("full") or only chosen
--     permissions ("partial"). Starts and ends by itself - checked on every request.
--   * Never delegated, whatever the scope: anything that could close, end or take over the
--     organisation - the plan and activation codes, data retention (automatic deletion),
--     API keys, the delegation itself, and the governance permissions that outlive a
--     delegation (permissions.assign, administrators.manage).
--   * Nobody decides their own request (leave, allowances, corrections, exceptions, open
--     shifts, swaps, deductions) - the real owner, who has nobody above, is the only exception.
--   * One rule for "a manager without a managed site holds only an employee's permissions" in
--     both permission checks (the server and the screens now agree).
--   * Reading the delegations and personal permissions is limited to the people concerned.
-- Builds on 20261104150000 (same table, same functions) - nothing parallel.
-- Rollback: drop the added columns and functions, and re-run the function bodies from
-- 20261104150000 / 20261020160000.

begin;

-- 1. The delegation window and scope ------------------------------------------------------
alter table public.owner_delegations
    add column if not exists starts_at timestamptz not null default now(),
    add column if not exists ends_at timestamptz,
    add column if not exists scope text not null default 'full',
    add column if not exists permission_keys text[] not null default '{}'::text[];

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'owner_delegations_scope_check') then
        alter table public.owner_delegations add constraint owner_delegations_scope_check check (scope in ('full', 'partial'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'owner_delegations_window_check') then
        alter table public.owner_delegations add constraint owner_delegations_window_check check (ends_at is null or ends_at > starts_at);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'owner_delegations_partial_keys_check') then
        alter table public.owner_delegations add constraint owner_delegations_partial_keys_check
            check (scope = 'full' or cardinality(permission_keys) > 0);
    end if;
end $$;

-- Governance permissions that are never delegated (they would outlive the delegation).
create or replace function public.prosm_time_undelegable_permissions()
returns text[]
language sql
immutable
set search_path = public
as $$
    select array['permissions.assign', 'administrators.manage'];
$$;
revoke all on function public.prosm_time_undelegable_permissions() from public, anon, authenticated;

-- An active delegation of the given scope, right now.
create or replace function public.prosm_time_active_delegation(p_user uuid)
returns public.owner_delegations
language sql
stable
security definer
set search_path = public
as $$
    select d.* from owner_delegations d join users u on u.id = d.user_id
    where d.user_id = p_user and d.revoked_at is null
      and d.starts_at <= now() and (d.ends_at is null or d.ends_at > now())
      and u.is_active and not u.is_owner and u.organization_id = d.organization_id
    order by d.granted_at desc
    limit 1;
$$;
revoke all on function public.prosm_time_active_delegation(uuid) from public, anon, authenticated;

-- Holds the owner's FULL authority right now.
create or replace function public.prosm_time_is_owner_delegate(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select d.scope = 'full' from public.prosm_time_active_delegation(p_user) d where d.id is not null), false);
$$;
-- Internal only now (it answered for any user id - a cross-organisation oracle).
revoke all on function public.prosm_time_is_owner_delegate(uuid) from public, anon, authenticated;
grant execute on function public.prosm_time_is_owner_delegate(uuid) to service_role;

-- The permissions a PARTIAL delegation gives right now.
create or replace function public.prosm_time_delegated_permissions(p_user uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select array(select k from unnest(d.permission_keys) k where not (k = any(public.prosm_time_undelegable_permissions())))
        from public.prosm_time_active_delegation(p_user) d
        where d.id is not null and d.scope = 'partial'
    ), array[]::text[]);
$$;
revoke all on function public.prosm_time_delegated_permissions(uuid) from public, anon, authenticated;

-- 2. One permission rule for the server checks (same as the screens) ----------------------
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
                join roles r on r.id = rdp.role_id
                join users u on u.role_id = rdp.role_id
                where u.id = p_user_id
                  and (
                      -- a manager without a managed site holds only an employee's permissions
                      r.role_key <> 'manager'
                      or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.role_at_site = 'manager')
                      or rdp.permission_id in (
                          select rdp2.permission_id from role_default_permissions rdp2
                          join roles r2 on r2.id = rdp2.role_id where r2.role_key = 'employee'
                      )
                  )
                union
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = true
                union
                select unnest(public.prosm_time_delegated_permissions(p_user_id))
                except
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = false
            ) effective
        ), array[]::text[]));
$function$;

-- The screens' list gains the partial delegation's permissions (an explicit removal still wins).
do $patch$
declare
    v_def text;
    v_anchor text := '            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = false';
begin
    v_def := pg_get_functiondef('public.get_prosm_time_effective_permissions(uuid)'::regprocedure);
    if position('prosm_time_delegated_permissions' in v_def) = 0 then
        if position(v_anchor in v_def) = 0 then
            raise exception 'effective permissions: anchor not found';
        end if;
        v_def := replace(v_def, v_anchor, '            union
            select unnest(public.prosm_time_delegated_permissions(v_target_id))
' || v_anchor);
        execute v_def;
    end if;
end;
$patch$;

-- 3. Nobody decides their own request -----------------------------------------------------
create or replace function public.prosm_time_caller_has_authority_over(p_subject_user_id uuid, p_site_id uuid default null::uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
    select exists (
        select 1 from users u
        where u.id = p_subject_user_id
          and u.organization_id = public.current_prosm_time_organization_id()
          -- authority over oneself is the real owner's alone (no one decides their own request)
          and (u.id <> public.current_prosm_time_user_id() or public.current_prosm_time_user_is_real_owner())
          and (
              public.current_prosm_time_user_is_owner()
              or (
                  public.prosm_time_can_act_on_behalf_of(public.current_prosm_time_user_id(), u.id)
                  and case
                      when p_site_id is not null then p_site_id = any(public.current_prosm_time_managed_site_ids())
                      else exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
                          or (
                              not exists (select 1 from site_assignments sa where sa.user_id = u.id)
                              and public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'people.unassigned')
                          )
                  end
              )
          )
    );
$function$;

-- The decisions that do not go through the authority check above.
do $patch$
declare
    v_def text;
    v_pairs text[][] := array[
        ['public.decide_prosm_time_open_shift_request(uuid,boolean)',
         'if v_request.id is null then raise exception ''REQUEST NOT FOUND''; end if;',
         'if v_request.id is null then raise exception ''REQUEST NOT FOUND''; end if;
    if v_request.user_id = public.current_prosm_time_user_id() then raise exception ''YOU CANNOT DECIDE YOUR OWN REQUEST''; end if;'],
        ['public.decide_prosm_time_shift_swap(uuid,boolean)',
         'if v_request.id is null then raise exception ''SWAP REQUEST NOT FOUND''; end if;',
         'if v_request.id is null then raise exception ''SWAP REQUEST NOT FOUND''; end if;
    if v_me in (v_request.from_user_id, v_request.to_user_id) then raise exception ''YOU CANNOT DECIDE YOUR OWN REQUEST''; end if;'],
        ['public.adjust_prosm_time_leave_deduction(uuid,numeric,text)',
         'if v_request.id is null then raise exception ''LEAVE REQUEST NOT FOUND''; end if;',
         'if v_request.id is null then raise exception ''LEAVE REQUEST NOT FOUND''; end if;
    if v_request.user_id = public.current_prosm_time_user_id() and not public.current_prosm_time_user_is_real_owner() then raise exception ''YOU CANNOT DECIDE YOUR OWN REQUEST''; end if;']
    ];
    v_i integer;
begin
    for v_i in 1 .. array_length(v_pairs, 1) loop
        v_def := pg_get_functiondef(v_pairs[v_i][1]::regprocedure);
        if position('YOU CANNOT DECIDE YOUR OWN REQUEST' in v_def) > 0 then continue; end if;
        if position(v_pairs[v_i][2] in v_def) = 0 then
            raise exception 'self-decision patch: anchor not found in %', v_pairs[v_i][1];
        end if;
        execute replace(v_def, v_pairs[v_i][2], v_pairs[v_i][3]);
    end loop;
end;
$patch$;

-- 4. What is never delegated: the real owner only ----------------------------------------
do $patch$
declare
    v_fn text;
    v_def text;
begin
    foreach v_fn in array array[
        'public.set_prosm_time_retention(integer,integer)',
        'public.redeem_prosm_time_activation_code(text)',
        'public.generate_prosm_time_api_key(text,text)'
    ] loop
        begin
            v_def := pg_get_functiondef(v_fn::regprocedure);
        exception when undefined_function then
            raise exception 'sovereign patch: % not found', v_fn;
        end;
        if position('current_prosm_time_user_is_owner()' in v_def) = 0 then
            raise exception 'sovereign patch: owner check not found in %', v_fn;
        end if;
        execute replace(v_def, 'current_prosm_time_user_is_owner()', 'current_prosm_time_user_is_real_owner()');
    end loop;

    -- the governance permissions are granted by the real owner only
    v_def := pg_get_functiondef('public.set_prosm_time_user_permission_override(uuid,text,boolean,text)'::regprocedure);
    if position('prosm_time_undelegable_permissions' in v_def) = 0 then
        if position('raise exception ''REASON IS REQUIRED'';
    end if;' in v_def) = 0 then
            raise exception 'override patch: anchor not found';
        end if;
        v_def := replace(v_def, 'raise exception ''REASON IS REQUIRED'';
    end if;', 'raise exception ''REASON IS REQUIRED'';
    end if;
    if p_is_granted and p_permission_key = any(public.prosm_time_undelegable_permissions())
       and not public.current_prosm_time_user_is_real_owner() then
        raise exception ''ONLY THE OWNER GRANTS THIS PERMISSION'';
    end if;');
        execute v_def;
    end if;
end;
$patch$;

-- 5. Grant with a window and a scope ------------------------------------------------------
drop function if exists public.grant_prosm_time_owner_authority(uuid, text);

create or replace function public.grant_prosm_time_owner_authority(
    p_user_id uuid,
    p_reason text,
    p_starts_at timestamptz default null,
    p_ends_at timestamptz default null,
    p_scope text default 'full',
    p_permission_keys text[] default null
)
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
    v_starts timestamptz := coalesce(p_starts_at, now());
    v_scope text := coalesce(nullif(trim(coalesce(p_scope, '')), ''), 'full');
    v_keys text[] := array(select distinct k from unnest(coalesce(p_permission_keys, array[]::text[])) k where k is not null);
    v_bad text;
    v_id uuid;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE OWNER GRANTS THE OWNER''S AUTHORITY'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    if v_scope not in ('full', 'partial') then raise exception 'INVALID SCOPE'; end if;
    if p_ends_at is not null and p_ends_at <= v_starts then raise exception 'THE END MUST BE AFTER THE START'; end if;
    if p_ends_at is not null and p_ends_at <= now() then raise exception 'THE END MUST BE IN THE FUTURE'; end if;
    if v_scope = 'partial' then
        if cardinality(v_keys) = 0 then raise exception 'CHOOSE AT LEAST ONE PERMISSION'; end if;
        select k into v_bad from unnest(v_keys) k where not exists (select 1 from permissions p where p.permission_key = k) limit 1;
        if v_bad is not null then raise exception 'UNKNOWN PERMISSION KEY'; end if;
        select k into v_bad from unnest(v_keys) k where k = any(public.prosm_time_undelegable_permissions()) limit 1;
        if v_bad is not null then raise exception 'THIS PERMISSION IS NEVER DELEGATED'; end if;
    else
        v_keys := array[]::text[];
    end if;
    select * into v_target from users where id = p_user_id and organization_id = v_org;
    if v_target.id is null then raise exception 'USER NOT FOUND'; end if;
    if v_target.is_owner then raise exception 'THE OWNER ALREADY HAS IT'; end if;
    if not v_target.is_active then raise exception 'THIS PERSON IS NOT ACTIVE'; end if;
    -- an ended delegation is closed automatically before a new one is granted
    update owner_delegations set revoked_at = now(), revoked_by = v_caller, revoke_reason = 'ended'
    where user_id = p_user_id and revoked_at is null and ends_at is not null and ends_at <= now();
    if exists (select 1 from owner_delegations where user_id = p_user_id and revoked_at is null) then
        raise exception 'THIS PERSON ALREADY HAS THE OWNER''S AUTHORITY';
    end if;

    insert into owner_delegations (organization_id, user_id, granted_by, reason, starts_at, ends_at, scope, permission_keys)
    values (v_org, p_user_id, v_caller, left(v_reason, 500), v_starts, p_ends_at, v_scope, v_keys)
    returning id into v_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (v_org, v_caller, p_user_id, 'OWNER_AUTHORITY_GRANTED', 'owner_delegations', v_id,
            case when v_scope = 'full' then 'The owner''s authority was delegated to ' else 'Some of the owner''s permissions were delegated to ' end
                || v_target.full_name || '.',
            v_reason,
            jsonb_build_object('reason', v_reason, 'scope', v_scope, 'permissionKeys', to_jsonb(v_keys), 'startsAt', v_starts, 'endsAt', p_ends_at));

    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'owner_authority_granted', 'high', 'You have the owner''s authority',
        case when v_scope = 'full' then 'The owner delegated their authority to you.' else 'The owner delegated some permissions to you.' end,
        'owner_delegations', v_id,
        jsonb_build_object('reason', v_reason, 'scope', v_scope, 'startsAt', v_starts, 'endsAt', p_ends_at));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.grant_prosm_time_owner_authority(uuid, text, timestamptz, timestamptz, text, text[]) from public, anon;
grant execute on function public.grant_prosm_time_owner_authority(uuid, text, timestamptz, timestamptz, text, text[]) to authenticated;

-- The signed-in person's own standing.
create or replace function public.get_prosm_time_my_owner_authority()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'delegate', public.prosm_time_is_owner_delegate(u.id),
        'scope', d.scope,
        'permissionKeys', coalesce(to_jsonb(d.permission_keys), '[]'::jsonb),
        'grantedAt', d.granted_at,
        'startsAt', d.starts_at,
        'endsAt', d.ends_at,
        'grantedBy', (select o.full_name from users o where o.id = d.granted_by))
    from users u
    left join lateral (select * from public.prosm_time_active_delegation(u.id)) d on d.id is not null
    where u.auth_user_id = auth.uid();
$$;
revoke all on function public.get_prosm_time_my_owner_authority() from public, anon;
grant execute on function public.get_prosm_time_my_owner_authority() to authenticated;

-- Copies of the owner's notifications go to FULL delegations that are active now.
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
        select d.user_id from owner_delegations d
        where d.organization_id = new.organization_id and d.revoked_at is null
          and public.prosm_time_is_owner_delegate(d.user_id)
    loop
        insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
        values (new.organization_id, v_delegate, new.type, new.priority, new.title, new.body, new.related_entity_type, new.related_entity_id,
                coalesce(new.data, '{}'::jsonb) || jsonb_build_object('ownerCopyOf', new.id));
    end loop;
    return new;
exception when others then
    return new;
end;
$$;
-- A trigger function: nobody calls it directly (anonGrants).
revoke all on function public.prosm_time_copy_owner_notification() from public, anon, authenticated;

-- 6. Who reads delegations and personal permissions ---------------------------------------
drop policy if exists owner_delegations_read on public.owner_delegations;
create policy owner_delegations_read on public.owner_delegations for select to authenticated
    using (
        organization_id = public.current_prosm_time_organization_id()
        and (user_id = public.current_prosm_time_user_id() or public.current_prosm_time_user_is_real_owner())
    );

do $$
declare
    v_name text;
begin
    for v_name in select policyname from pg_policies where schemaname = 'public' and tablename = 'user_permission_overrides' and cmd = 'SELECT' loop
        execute format('drop policy %I on public.user_permission_overrides', v_name);
    end loop;
end $$;
create policy user_permission_overrides_read on public.user_permission_overrides for select to authenticated
    using (
        user_id = public.current_prosm_time_user_id()
        or (
            user_id in (select u.id from users u where u.organization_id = public.current_prosm_time_organization_id())
            and (
                (select public.current_prosm_time_user_is_owner())
                or (select 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[])))
                or public.prosm_time_caller_has_authority_over(user_id)
            )
        )
    );

commit;
