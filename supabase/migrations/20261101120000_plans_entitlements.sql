-- 2026-11-01 (Play release plan, stage 3): plans and entitlements, set by people
-- at PROSM, with no payment. license_activation_state stays the source of
-- licence expiry and locking. Every organisation that exists today becomes
-- 'legacy' (no new limit), so no current customer changes; a new trial is Pro.
-- A plan's limits are enforced here, not in the interface. After a paid plan
-- ends there are 7 days' grace before the organisation locks; no data is deleted.
-- Rollback: drop the triggers, functions and four tables below, and restore
-- prosm_time_org_locked from 20261027170000.

begin;

create table public.plans (
    key text primary key,
    name text not null,
    max_employees integer,
    max_sites integer,
    history_days integer,
    feature_flags jsonb not null default '{}'::jsonb
);

insert into public.plans (key, name, max_employees, max_sites, history_days, feature_flags) values
    ('legacy', 'Existing customer', null, null, null, '{"leave": true, "approvals": true, "kiosk": true, "export": true, "audit": true, "sos": true, "multi_role": true}'),
    ('starter', 'Starter', null, 3, 365, '{}'),
    ('business', 'Business', null, null, 730, '{"leave": true, "approvals": true, "kiosk": true, "export": true}'),
    ('pro', 'Pro', null, null, 1825, '{"leave": true, "approvals": true, "kiosk": true, "export": true, "audit": true, "sos": true, "multi_role": true}');

create table public.entitlements (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    plan text not null references public.plans(key),
    status text not null check (status in ('trial', 'active', 'expired', 'suspended')),
    starts_at timestamptz not null default now(),
    ends_at timestamptz,
    seats integer,
    notes text,
    updated_at timestamptz not null default now()
);

create table public.activation_codes (
    id uuid primary key default gen_random_uuid(),
    code_hash text not null unique,
    plan text not null references public.plans(key),
    duration_days integer not null check (duration_days > 0),
    seats integer,
    uses_max integer not null default 1 check (uses_max = 1),
    expires_at timestamptz,
    issued_by text,
    status text not null default 'issued' check (status in ('issued', 'redeemed', 'cancelled')),
    redeemed_by_organization uuid references public.organizations(id) on delete set null,
    redeemed_at timestamptz,
    created_at timestamptz not null default now()
);

create table public.entitlement_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references public.organizations(id) on delete cascade,
    event text not null,
    actor_user_id uuid references public.users(id) on delete set null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.plans enable row level security;
alter table public.entitlements enable row level security;
alter table public.activation_codes enable row level security;
alter table public.entitlement_events enable row level security;
revoke all on public.plans, public.entitlements, public.activation_codes, public.entitlement_events from anon, authenticated;
grant select on public.entitlements to authenticated;

create policy "the owner sees the organisation's plan" on public.entitlements
for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

-- Every organisation has one. Today's are legacy; trials keep their end date.
insert into public.entitlements (organization_id, plan, status, starts_at, ends_at, seats, notes)
select o.id, 'legacy', case when l.is_trial then 'trial' else 'active' end, coalesce(l.activated_at, o.created_at), l.expires_at, l.max_users, 'existing before plans'
from public.organizations o
left join public.license_activation_state l on l.organization_id = o.id;

-- A new licence row: a trial is Pro in full, anything else legacy until PROSM sets a plan.
create or replace function public.prosm_time_entitlement_for_new_license()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    insert into entitlements (organization_id, plan, status, starts_at, ends_at, seats)
    values (new.organization_id, case when new.is_trial then 'pro' else 'legacy' end, case when new.is_trial then 'trial' else 'active' end, now(), new.expires_at, new.max_users)
    on conflict (organization_id) do update
    set plan = case when excluded.status = 'trial' then 'pro' else entitlements.plan end,
        status = case when excluded.status = 'trial' then 'trial' else entitlements.status end,
        ends_at = excluded.ends_at, updated_at = now();
    return new;
end;
$function$;
revoke all on function public.prosm_time_entitlement_for_new_license() from public, anon, authenticated;

create trigger license_keeps_entitlement
after insert or update of is_trial, expires_at on public.license_activation_state
for each row execute function public.prosm_time_entitlement_for_new_license();

-- The plan's own limits, on top of the licence's.
create or replace function public.prosm_time_enforce_plan_sites()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_max integer;
begin
    if not new.is_active then return new; end if;
    if tg_op = 'UPDATE' and old.is_active then return new; end if;
    select p.max_sites into v_max
    from entitlements e join plans p on p.key = e.plan
    where e.organization_id = new.organization_id;
    if v_max is not null and (select count(*) from sites where organization_id = new.organization_id and is_active and id <> new.id) >= v_max then
        raise exception 'PLAN SITE LIMIT REACHED';
    end if;
    return new;
end;
$function$;
revoke all on function public.prosm_time_enforce_plan_sites() from public, anon, authenticated;

create trigger sites_enforce_plan
before insert or update of is_active on public.sites
for each row execute function public.prosm_time_enforce_plan_sites();

create or replace function public.prosm_time_enforce_plan_employees()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_max integer;
begin
    if not new.is_active or (tg_op = 'UPDATE' and old.is_active and old.organization_id = new.organization_id) then
        return new;
    end if;
    select coalesce(e.seats, p.max_employees) into v_max
    from entitlements e join plans p on p.key = e.plan
    where e.organization_id = new.organization_id and e.plan <> 'legacy' and e.status <> 'trial';
    if v_max is not null and (select count(*) from users where organization_id = new.organization_id and is_active and id <> new.id) >= v_max then
        raise exception 'PLAN EMPLOYEE LIMIT REACHED';
    end if;
    return new;
end;
$function$;
revoke all on function public.prosm_time_enforce_plan_employees() from public, anon, authenticated;

create trigger users_enforce_plan
before insert or update of is_active, organization_id on public.users
for each row execute function public.prosm_time_enforce_plan_employees();

-- 7 days' grace after a paid plan ends; a trial still ends on its day.
create or replace function public.prosm_time_org_locked(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from license_activation_state l
        where l.organization_id = p_org
          and (
              (l.expires_at is not null and l.expires_at + case when l.is_trial then interval '0' else interval '7 days' end <= now())
              or upper(coalesce(l.status, '')) in ('SUSPENDED', 'REVOKED', 'CANCELLED', 'BLOCKED', 'EXPIRED')
          ));
$function$;

-- The owner's plan screen.
create or replace function public.get_prosm_time_plan_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_entitlement entitlements%rowtype;
    v_plan plans%rowtype;
begin
    if v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN SEE THE LICENCE'; end if;
    select * into v_entitlement from entitlements where organization_id = v_org;
    select * into v_plan from plans where key = v_entitlement.plan;
    return jsonb_build_object(
        'plan', v_entitlement.plan,
        'status', v_entitlement.status,
        'endsAt', v_entitlement.ends_at,
        'graceEndsAt', case when v_entitlement.status = 'trial' then v_entitlement.ends_at else v_entitlement.ends_at + interval '7 days' end,
        'employees', (select count(*) from users where organization_id = v_org and is_active),
        'sites', (select count(*) from sites where organization_id = v_org and is_active),
        'maxEmployees', coalesce(v_entitlement.seats, v_plan.max_employees),
        'maxSites', v_plan.max_sites
    );
end;
$function$;
revoke all on function public.get_prosm_time_plan_status() from public, anon;
grant execute on function public.get_prosm_time_plan_status() to authenticated;

-- The owner enters a code PROSM issued: one use, tied to the organisation, with
-- attempts limited and failures recorded. No payment happens here.
create or replace function public.redeem_prosm_time_activation_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_limit jsonb;
    v_code activation_codes%rowtype;
    v_ends timestamptz;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN ENTER A CODE'; end if;

    v_limit := public.consume_prosm_time_rate_limit('activation_code', v_org::text, 5, 900, 3600);
    if not coalesce((v_limit ->> 'allowed')::boolean, false) then raise exception 'TOO MANY ATTEMPTS'; end if;

    select * into v_code from activation_codes
    where code_hash = encode(extensions.digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex')
    for update;
    if v_code.id is null or v_code.status <> 'issued' or (v_code.expires_at is not null and v_code.expires_at <= now()) then
        insert into entitlement_events (organization_id, event, actor_user_id) values (v_org, 'code.failed', v_caller);
        return jsonb_build_object('success', false, 'error', 'INVALID ACTIVATION CODE');
    end if;

    v_ends := now() + make_interval(days => v_code.duration_days);
    update activation_codes set status = 'redeemed', redeemed_by_organization = v_org, redeemed_at = now() where id = v_code.id;
    update license_activation_state
    set status = 'ACTIVE', is_trial = false, expires_at = v_ends, max_users = coalesce(v_code.seats, max_users), updated_at = now()
    where organization_id = v_org;
    update entitlements
    set plan = v_code.plan, status = 'active', starts_at = now(), ends_at = v_ends, seats = v_code.seats, updated_at = now()
    where organization_id = v_org;
    insert into entitlement_events (organization_id, event, actor_user_id, details)
    values (v_org, 'code.redeemed', v_caller, jsonb_build_object('codeId', v_code.id, 'plan', v_code.plan, 'endsAt', v_ends));

    return jsonb_build_object('success', true, 'plan', v_code.plan, 'endsAt', v_ends);
end;
$function$;
revoke all on function public.redeem_prosm_time_activation_code(text) from public, anon;
grant execute on function public.redeem_prosm_time_activation_code(text) to authenticated;

commit;
