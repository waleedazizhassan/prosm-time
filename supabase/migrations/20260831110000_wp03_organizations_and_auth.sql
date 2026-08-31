-- PROSM Time Implementation Master File V3.0, WP-03 (§38: "Authentication
-- & Organization | Activation (consuming WP-00's API), organization
-- setup, administrator onboarding, secure authentication").
--
-- Scope boundary, deliberate: this migration builds exactly WP-03's own
-- listed scope - the organization itself, the Owner/Primary
-- Administrator, secure auth linkage, and the local (never-authoritative,
-- §34) cache of PROSM Management's license state. It does NOT build the
-- granular per-admin permission model (§9's VIEW/CREATE/EDIT/DELETE/
-- EXECUTE/APPROVE/EXPORT/ADMINISTER matrix, invitations, device binding)
-- - that is WP-04's own explicit scope ("People & Roles & Permissions").
-- `roles` here is the fixed, global role vocabulary §12 names
-- (Owner/Manager/Supervisor/Employee/Read-only) as a simple catalog -
-- "roles are a convenient bundle, not a hard ceiling" (§12); WP-04 layers
-- real per-admin permission grants on top of this, it does not replace it.

begin;

-- ============================================================
-- 1. Schema
-- ============================================================

create table public.organizations (
    id uuid primary key default gen_random_uuid(),
    organization_code text not null unique,
    name text not null,
    status text not null default 'active' check (status in ('active', 'suspended', 'deactivated')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.organization_settings (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    -- §27/§28 defaults - real, editable settings (not hard-coded UI
    -- behavior). default_theme is 'dark' per §28 ("Dark Mode is the
    -- default application appearance").
    default_language text not null default 'en',
    default_theme text not null default 'dark' check (default_theme in ('dark', 'light', 'system')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- §12: "Owner/Primary Administrator, Manager/Site Manager, Supervisor/
-- Team Lead, Employee, Read-only/reporting role." Global catalog (not
-- per-organization) - every organization draws from the same five named
-- roles; WP-04's granular permission assignments are what actually make
-- one admin's authority differ from another's, on top of this bundle.
create table public.roles (
    id uuid primary key default gen_random_uuid(),
    role_key text not null unique check (role_key in ('owner', 'manager', 'supervisor', 'employee', 'read_only')),
    name text not null,
    description text,
    created_at timestamptz not null default now()
);

-- §12: "Separate authentication identity from employee/workforce
-- profile." auth_user_id is the only link to Supabase Auth - every
-- other identity fact (name, role, org membership, status) lives here,
-- server-enforced (§9: "the client only reflects, never enforces,
-- permission state").
create table public.users (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid not null unique references auth.users(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    role_id uuid not null references public.roles(id),
    email text not null,
    full_name text not null,
    status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
    -- The Owner/Primary Administrator "has the highest administrative
    -- authority within the organization... An administrator does not
    -- automatically receive full Owner authority" (§9). Exactly one real
    -- owner per organization, enforced below (partial unique index), not
    -- merely a role label.
    is_owner boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, email)
);

create unique index users_one_owner_per_organization
    on public.users (organization_id)
    where is_owner = true;

-- §34: "local cache of PROSM Management's record, never authoritative."
-- One row per organization - PROSM Time's own honest, always-refreshable
-- reflection of what PROSM Management's integration contract last said,
-- never a second source of licensing truth (§5: "Licensing authority is
-- never duplicated").
create table public.license_activation_state (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    license_number text not null unique,
    status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
    -- plan_id is PROSM Management's own prosm_product_plans.id - an
    -- opaque foreign reference into a database PROSM Time never queries
    -- directly (§6/§43.6), stored as plain uuid with no local FK.
    plan_id uuid,
    max_users integer,
    max_devices integer,
    activated_at timestamptz not null default now(),
    expires_at timestamptz,
    last_verified_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- §26: "Every sensitive administrative operation must be auditable."
-- Actor/Subject distinction is real from the first row - subject_user_id
-- is null for actions with no separate subject (e.g. the org's own
-- activation), populated for §10-style on-behalf actions once WP-07
-- builds them, per this table's own header already anticipating that
-- shape rather than needing a later migration to add it.
create table public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    actor_user_id uuid references public.users(id) on delete set null,
    subject_user_id uuid references public.users(id) on delete set null,
    action text not null,
    entity_name text not null,
    entity_id uuid,
    description text,
    reason text,
    previous_state jsonb,
    new_state jsonb,
    context jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index users_organization_id_idx on public.users(organization_id);
create index audit_logs_organization_id_idx on public.audit_logs(organization_id);
create index audit_logs_created_at_idx on public.audit_logs(created_at desc);

-- ============================================================
-- 2. Role catalog seed (§12's fixed vocabulary)
-- ============================================================

insert into public.roles (role_key, name, description) values
    ('owner', 'Owner / Primary Administrator', 'Highest administrative authority within the organization (§9).'),
    ('manager', 'Manager / Site Manager', 'Site-scoped operational and approval authority.'),
    ('supervisor', 'Supervisor / Team Lead', 'Team-level oversight, no organization-wide administration.'),
    ('employee', 'Employee', 'Self-service attendance only.'),
    ('read_only', 'Read-only / Reporting', 'View and export access, no write authority.');

-- ============================================================
-- 3. RLS helpers - resolve the caller's own organization/user id from
--    auth.uid(), the one thing every future tenant-scoped policy in
--    this codebase will call. Mirrors the exact convention PROSM
--    Platform/PROSM Management use (current_user_organization_id()/
--    is_platform_owner()) - independent implementation, same shape.
-- ============================================================

create or replace function public.current_prosm_time_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select id from public.users where auth_user_id = auth.uid();
$function$;

create or replace function public.current_prosm_time_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select organization_id from public.users where auth_user_id = auth.uid();
$function$;

create or replace function public.current_prosm_time_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce((select is_owner from public.users where auth_user_id = auth.uid()), false);
$function$;

-- ============================================================
-- 4. RLS - every table tenant-scoped by organization_id (§24: "RLS on
--    tenant-owned tables"). No client INSERT/UPDATE/DELETE grant on
--    any of these - every mutation goes through the RPCs/Edge
--    Functions below (§9/§35: "the client only reflects, never
--    enforces").
-- ============================================================

alter table public.organizations enable row level security;
alter table public.organization_settings enable row level security;
alter table public.roles enable row level security;
alter table public.users enable row level security;
alter table public.license_activation_state enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_settings from anon, authenticated;
revoke all on public.roles from anon, authenticated;
revoke all on public.users from anon, authenticated;
revoke all on public.license_activation_state from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

grant select on public.organizations to authenticated;
grant select on public.organization_settings to authenticated;
grant select on public.roles to authenticated;
grant select on public.users to authenticated;
grant select on public.license_activation_state to authenticated;
grant select on public.audit_logs to authenticated;

create policy "members can view own organization"
on public.organizations for select to authenticated
using (id = public.current_prosm_time_organization_id());

create policy "members can view own organization settings"
on public.organization_settings for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

-- Roles are a global, non-tenant catalog (§12) - readable by any
-- authenticated user, exactly like PROSM Management's own
-- prosm_product_plans is readable within its own authorization
-- boundary; nothing tenant-sensitive lives on this table.
create policy "authenticated users can view the role catalog"
on public.roles for select to authenticated
using (true);

create policy "members can view users in own organization"
on public.users for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

create policy "members can view own organization license state"
on public.license_activation_state for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

-- Audit log visibility is Owner-only for now - WP-04 has not yet built
-- the granular ADMINISTER-type permission this should really gate on
-- (§9/§21 lists Audit under the Manager/Administration Console). The
-- Owner always has full authority (§9), so this is a correct, honest
-- default until WP-04 replaces it with a real permission check - never
-- opened to every org member in the meantime.
create policy "owner can view own organization audit log"
on public.audit_logs for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

-- ============================================================
-- 5. Bootstrap RPC - the one place an organization, its Owner, and its
--    license state come into existence together. Called ONLY from the
--    activate-organization Edge Function, which has already (a)
--    verified the activation code server-side against PROSM
--    Management's integration contract (§5: "never trust a
--    client-only activation flag") and (b) created the real Supabase
--    Auth account. This function trusts the auth_user_id it is given
--    exactly the way PROSM Platform's own establish_organization_owner
--    trusts its caller-resolved parameters - security definer, but the
--    calling Edge Function is what makes that safe, not this function
--    authenticating anyone itself.
-- ============================================================

create or replace function public.generate_organization_code()
returns text
language sql
volatile
as $function$
    select 'PMTIME-ORG-' || upper(substring(md5(gen_random_uuid()::text), 1, 8));
$function$;

create or replace function public.bootstrap_prosm_time_organization(
    p_organization_name text,
    p_auth_user_id uuid,
    p_owner_email text,
    p_owner_full_name text,
    p_license_number text,
    p_plan_id uuid,
    p_max_users integer,
    p_max_devices integer,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_organization_id uuid;
    v_user_id uuid;
    v_owner_role_id uuid;
begin
    if p_organization_name is null or length(trim(p_organization_name)) = 0 then
        raise exception 'ORGANIZATION NAME IS REQUIRED';
    end if;

    if p_owner_email is null or length(trim(p_owner_email)) = 0 then
        raise exception 'OWNER EMAIL IS REQUIRED';
    end if;

    if p_auth_user_id is null then
        raise exception 'AUTH USER ID IS REQUIRED';
    end if;

    if p_license_number is null or length(trim(p_license_number)) = 0 then
        raise exception 'LICENSE NUMBER IS REQUIRED';
    end if;

    select id into v_owner_role_id from roles where role_key = 'owner';
    if v_owner_role_id is null then
        raise exception 'OWNER ROLE NOT FOUND - ROLE CATALOG NOT SEEDED';
    end if;

    insert into organizations (organization_code, name, status)
    values (public.generate_organization_code(), p_organization_name, 'active')
    returning id into v_organization_id;

    insert into organization_settings (organization_id)
    values (v_organization_id);

    insert into license_activation_state (
        organization_id, license_number, status, plan_id, max_users, max_devices, expires_at
    ) values (
        v_organization_id, p_license_number, 'ACTIVE', p_plan_id, p_max_users, p_max_devices, p_expires_at
    );

    insert into users (
        auth_user_id, organization_id, role_id, email, full_name, status, is_owner
    ) values (
        p_auth_user_id, v_organization_id, v_owner_role_id, lower(trim(p_owner_email)), p_owner_full_name, 'active', true
    )
    returning id into v_user_id;

    insert into audit_logs (
        organization_id, actor_user_id, action, entity_name, entity_id, description, context
    ) values (
        v_organization_id, v_user_id, 'ORGANIZATION_ACTIVATED', 'organizations', v_organization_id,
        'Organization activated and Owner account established via PROSM Management activation code.',
        jsonb_build_object('licenseNumber', p_license_number, 'ownerEmail', p_owner_email)
    );

    return jsonb_build_object(
        'success', true,
        'organizationId', v_organization_id,
        'userId', v_user_id
    );
exception
    when unique_violation then
        raise exception 'BOOTSTRAP PROSM TIME ORGANIZATION FAILED: A record with this identifier already exists (%).', sqlerrm;
    when others then
        raise exception 'BOOTSTRAP PROSM TIME ORGANIZATION FAILED: %', sqlerrm;
end;
$function$;

-- SECURITY DEFINER, but deliberately NOT granted to `authenticated`/
-- `anon` - the only legal caller is the activate-organization Edge
-- Function, running with the service role key, exactly like every
-- integration-contract RPC in PROSM Management's own migration
-- (20260831100000) is service_role-only for the same reason: a
-- PROSM Time session must never be able to fabricate its own
-- organization/license state by calling this directly.
revoke execute on function public.bootstrap_prosm_time_organization(text, uuid, text, text, text, uuid, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.bootstrap_prosm_time_organization(text, uuid, text, text, text, uuid, integer, integer, timestamptz) to service_role;

-- ============================================================
-- 6. License refresh RPC - re-applies PROSM Management's latest
--    licenseStatus response to the local cache (§5: "License renewal,
--    suspension, expiration and revocation are lifecycle states...
--    reflected in the standalone app via the integration contract").
--    Called from the refresh-license-status Edge Function on behalf of
--    an already-authenticated organization member - not service-role-
--    only like bootstrap, but still not directly callable by a client
--    with a forged status: the Edge Function is what actually fetched
--    p_status/p_expires_at from PROSM Management moments earlier.
-- ============================================================

create or replace function public.refresh_prosm_time_license_state(
    p_organization_id uuid,
    p_status text,
    p_max_users integer,
    p_max_devices integer,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if p_status not in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED') then
        raise exception 'INVALID LICENSE STATUS';
    end if;

    update license_activation_state
    set
        status = p_status,
        max_users = coalesce(p_max_users, max_users),
        max_devices = coalesce(p_max_devices, max_devices),
        expires_at = p_expires_at,
        last_verified_at = now(),
        updated_at = now()
    where organization_id = p_organization_id;

    if not found then
        raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION';
    end if;

    return jsonb_build_object('success', true, 'organizationId', p_organization_id, 'status', p_status);
exception
    when others then
        raise exception 'REFRESH PROSM TIME LICENSE STATE FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz) to service_role;

commit;
