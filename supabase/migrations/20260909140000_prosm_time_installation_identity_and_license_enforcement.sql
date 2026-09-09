-- PROSM Time - Installation Identity, server-side License Enforcement and
-- the automatic Protection-Policy channel.
--
-- Design rules this migration obeys (they are not negotiable):
--   * PROSM Management stays the sole licensing authority (§5). Nothing here
--     issues a license; this migration only enforces, with the SERVER clock,
--     the state that license_activation_state already reflects.
--   * Every new table has RLS enabled and NO privileges for anon/authenticated.
--     All access goes through service_role-only SECURITY DEFINER functions
--     called from Edge Functions, so a modified client cannot reach them.
--   * A protection-policy update can only tune a fixed, whitelisted set of
--     knobs. It can never disable licensing enforcement, authorization, audit
--     logging or RLS - those are compiled into the functions below.

-- ============================================================
-- 1. Settings (grace period is configurable, server-side only)
-- ============================================================

create table if not exists public.prosm_time_license_settings (
    id boolean primary key default true check (id),
    grace_period_days integer not null default 30 check (grace_period_days between 1 and 365),
    updated_at timestamptz not null default now()
);

insert into public.prosm_time_license_settings (id) values (true) on conflict (id) do nothing;

-- ============================================================
-- 2. Installation identity
-- ============================================================

create table if not exists public.prosm_time_installations (
    id uuid primary key default gen_random_uuid(),
    installation_key text not null unique,
    -- Only the SHA-256 of the server-issued secret is stored. The plaintext
    -- secret is returned exactly once, at registration.
    secret_hash text not null,
    organization_id uuid references public.organizations(id) on delete set null,
    platform text not null default 'unknown' check (platform in ('web', 'android', 'windows', 'unknown')),
    app_version text,
    device_label text,
    -- Remote administrative override, owned by the control plane.
    admin_state text not null default 'NONE' check (admin_state in ('NONE', 'SUSPENDED', 'BLOCKED', 'REVOKED')),
    -- Server-clock grace period start. Never supplied by a client.
    grace_started_at timestamptz,
    last_state text,
    registered_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists prosm_time_installations_org_idx on public.prosm_time_installations(organization_id);
create index if not exists prosm_time_installations_last_seen_idx on public.prosm_time_installations(last_seen_at desc);

create table if not exists public.prosm_time_installation_sessions (
    id uuid primary key default gen_random_uuid(),
    installation_id uuid not null references public.prosm_time_installations(id) on delete cascade,
    user_id uuid,
    organization_id uuid,
    started_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    ended_at timestamptz,
    ended_reason text
);

create index if not exists prosm_time_installation_sessions_installation_idx
    on public.prosm_time_installation_sessions(installation_id);
create unique index if not exists prosm_time_installation_sessions_open_idx
    on public.prosm_time_installation_sessions(installation_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
    where ended_at is null;

create table if not exists public.prosm_time_security_events (
    id uuid primary key default gen_random_uuid(),
    installation_id uuid references public.prosm_time_installations(id) on delete cascade,
    organization_id uuid,
    event_type text not null,
    operation text,
    state text,
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists prosm_time_security_events_installation_idx
    on public.prosm_time_security_events(installation_id, created_at desc);

-- ============================================================
-- 3. Protection policy channel (automatic, signed, atomic)
-- ============================================================

create table if not exists public.prosm_time_protection_policies (
    id uuid primary key default gen_random_uuid(),
    version integer not null unique check (version > 0),
    payload jsonb not null,
    checksum text not null,
    status text not null default 'STAGED' check (status in ('STAGED', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'REJECTED')),
    staged_at timestamptz not null default now(),
    activated_at timestamptz,
    rejected_reason text
);

create unique index if not exists prosm_time_protection_policies_one_active
    on public.prosm_time_protection_policies(status) where status = 'ACTIVE';

create table if not exists public.prosm_time_protection_runtime (
    id boolean primary key default true check (id),
    active_version integer,
    previous_version integer,
    last_check_at timestamptz,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_failure_reason text,
    last_rollback_at timestamptz,
    updated_at timestamptz not null default now()
);

insert into public.prosm_time_protection_runtime (id) values (true) on conflict (id) do nothing;

-- Seed the built-in, known-good baseline policy so protection is active from
-- the first boot, with no network call and no manual step.
insert into public.prosm_time_protection_policies (version, payload, checksum, status, activated_at)
values (
    1,
    jsonb_build_object(
        'graceperioddays', 30,
        'validationintervalminutes', 60,
        'maxvalidationfailures', 10,
        'blockonunknowninstallation', false
    ),
    'baseline',
    'ACTIVE',
    now()
) on conflict (version) do nothing;

update public.prosm_time_protection_runtime
set active_version = 1, last_success_at = now(), updated_at = now()
where id = true and active_version is null;

-- ============================================================
-- 4. Lock everything down
-- ============================================================

alter table public.prosm_time_license_settings enable row level security;
alter table public.prosm_time_installations enable row level security;
alter table public.prosm_time_installation_sessions enable row level security;
alter table public.prosm_time_security_events enable row level security;
alter table public.prosm_time_protection_policies enable row level security;
alter table public.prosm_time_protection_runtime enable row level security;

revoke all on public.prosm_time_license_settings from public, anon, authenticated;
revoke all on public.prosm_time_installations from public, anon, authenticated;
revoke all on public.prosm_time_installation_sessions from public, anon, authenticated;
revoke all on public.prosm_time_security_events from public, anon, authenticated;
revoke all on public.prosm_time_protection_policies from public, anon, authenticated;
revoke all on public.prosm_time_protection_runtime from public, anon, authenticated;

grant all on public.prosm_time_license_settings to service_role;
grant all on public.prosm_time_installations to service_role;
grant all on public.prosm_time_installation_sessions to service_role;
grant all on public.prosm_time_security_events to service_role;
grant all on public.prosm_time_protection_policies to service_role;
grant all on public.prosm_time_protection_runtime to service_role;

-- ============================================================
-- 5. Internal helpers
-- ============================================================

create or replace function public.prosm_time_hash_secret(p_secret text)
returns text
language sql
immutable
set search_path = public
as $function$
    select encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
$function$;

revoke execute on function public.prosm_time_hash_secret(text) from public, anon, authenticated;
grant execute on function public.prosm_time_hash_secret(text) to service_role;

create or replace function public.prosm_time_record_security_event(
    p_installation_id uuid,
    p_organization_id uuid,
    p_event_type text,
    p_operation text default null,
    p_state text default null,
    p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    insert into prosm_time_security_events (installation_id, organization_id, event_type, operation, state, detail)
    values (p_installation_id, p_organization_id, p_event_type, p_operation, p_state, coalesce(p_detail, '{}'::jsonb));

    -- The product's own audit trail only accepts organization-scoped rows.
    if p_organization_id is not null then
        begin
            insert into audit_logs (organization_id, action, entity_name, entity_id, description)
            values (
                p_organization_id,
                p_event_type,
                'prosm_time_installations',
                p_installation_id,
                coalesce(p_operation, p_state, p_event_type)
            );
        exception when others then
            -- Auditing to the product log must never break enforcement; the
            -- security-event row above is the authoritative record.
            null;
        end;
    end if;
end;
$function$;

revoke execute on function public.prosm_time_record_security_event(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.prosm_time_record_security_event(uuid, uuid, text, text, text, jsonb) to service_role;

-- Effective grace period: the active protection policy may tune it inside a
-- hard-coded range; it can never remove it.
create or replace function public.prosm_time_effective_grace_days()
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_days integer;
    v_policy integer;
begin
    select grace_period_days into v_days from prosm_time_license_settings where id = true;
    select (payload->>'graceperioddays')::integer into v_policy
    from prosm_time_protection_policies where status = 'ACTIVE';

    if v_policy is not null and v_policy between 1 and 365 then
        v_days := v_policy;
    end if;

    return coalesce(v_days, 30);
end;
$function$;

revoke execute on function public.prosm_time_effective_grace_days() from public, anon, authenticated;
grant execute on function public.prosm_time_effective_grace_days() to service_role;

-- ============================================================
-- 6. Registration
-- ============================================================

create or replace function public.register_prosm_time_installation(
    p_platform text default 'unknown',
    p_app_version text default null,
    p_device_label text default null,
    p_auth_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_key text := replace(gen_random_uuid()::text, '-', '');
    v_secret text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_organization_id uuid;
    v_installation prosm_time_installations%rowtype;
    v_platform text := lower(coalesce(nullif(trim(p_platform), ''), 'unknown'));
begin
    if v_platform not in ('web', 'android', 'windows') then
        v_platform := 'unknown';
    end if;

    -- The organization is derived from the caller's own server-side user row,
    -- never from anything the client claims.
    if p_auth_user_id is not null then
        select organization_id into v_organization_id from users where auth_user_id = p_auth_user_id;
    end if;

    insert into prosm_time_installations (
        installation_key, secret_hash, organization_id, platform, app_version, device_label
    ) values (
        v_key, prosm_time_hash_secret(v_secret), v_organization_id, v_platform,
        nullif(trim(coalesce(p_app_version, '')), ''), nullif(trim(coalesce(p_device_label, '')), '')
    ) returning * into v_installation;

    perform prosm_time_record_security_event(
        v_installation.id, v_organization_id, 'INSTALLATION_REGISTERED', null, null,
        jsonb_build_object('platform', v_platform, 'appVersion', p_app_version)
    );

    return jsonb_build_object(
        'success', true,
        'installationKey', v_key,
        'installationSecret', v_secret
    );
end;
$function$;

revoke execute on function public.register_prosm_time_installation(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.register_prosm_time_installation(text, text, text, uuid) to service_role;

-- ============================================================
-- 7. The single enforcement core
-- ============================================================
-- Resolves the installation from its key+secret, re-derives the organization
-- from the authenticated user server-side, applies the remote administrative
-- override, then the license state, then the server-clock grace window.

create or replace function public.evaluate_prosm_time_installation(
    p_installation_key text,
    p_installation_secret text,
    p_auth_user_id uuid default null,
    p_app_version text default null,
    p_operation text default null,
    p_touch boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_installation prosm_time_installations%rowtype;
    v_organization_id uuid;
    v_license license_activation_state%rowtype;
    v_state text;
    v_grace_days integer := prosm_time_effective_grace_days();
    v_grace_ends timestamptz;
    v_days_remaining integer;
    v_now timestamptz := now();
    v_identified boolean := false;
begin
    if p_auth_user_id is not null then
        select organization_id into v_organization_id from users where auth_user_id = p_auth_user_id;
    end if;

    if p_installation_key is not null and p_installation_secret is not null then
        select * into v_installation from prosm_time_installations
        where installation_key = p_installation_key
          and secret_hash = prosm_time_hash_secret(p_installation_secret)
        for update;

        if found then
            v_identified := true;
        else
            -- A key that does not match its secret is a forged identity.
            perform prosm_time_record_security_event(
                null, v_organization_id, 'INSTALLATION_IDENTITY_REJECTED', p_operation, null,
                jsonb_build_object('reason', 'UNKNOWN_OR_INVALID_INSTALLATION')
            );
        end if;
    end if;

    if v_identified then
        -- Bind (or re-bind) the installation to the organization the
        -- authenticated caller really belongs to.
        if v_organization_id is not null and v_installation.organization_id is distinct from v_organization_id then
            update prosm_time_installations
            set organization_id = v_organization_id, updated_at = v_now
            where id = v_installation.id
            returning * into v_installation;
        end if;
        v_organization_id := coalesce(v_organization_id, v_installation.organization_id);
    end if;

    if v_organization_id is not null then
        select * into v_license from license_activation_state where organization_id = v_organization_id;
    end if;

    -- 7a. Remote administrative override always wins.
    if v_identified and v_installation.admin_state <> 'NONE' then
        v_state := v_installation.admin_state;
    -- 7b. License lifecycle states owned by PROSM Management.
    elsif v_license.id is not null and v_license.status = 'SUSPENDED' then
        v_state := 'SUSPENDED';
    elsif v_license.id is not null and v_license.status = 'REVOKED' then
        v_state := 'REVOKED';
    elsif v_license.id is not null
        and v_license.status = 'ACTIVE'
        and (v_license.expires_at is null or v_license.expires_at > v_now) then
        v_state := 'LICENSED';
    elsif v_license.id is not null then
        -- ACTIVE but past expiry, or explicitly EXPIRED.
        v_state := 'EXPIRED';
    else
        -- 7c. No license at all: unauthorized installation -> server-clock
        -- grace period, started once and never restarted by the client.
        if v_identified then
            if v_installation.grace_started_at is null then
                update prosm_time_installations
                set grace_started_at = v_now, updated_at = v_now
                where id = v_installation.id
                returning * into v_installation;

                perform prosm_time_record_security_event(
                    v_installation.id, v_organization_id, 'GRACE_PERIOD_STARTED', p_operation, 'GRACE',
                    jsonb_build_object('graceDays', v_grace_days)
                );
            end if;
            v_grace_ends := v_installation.grace_started_at + make_interval(days => v_grace_days);
        else
            -- An unidentified installation gets no open-ended grace: it is
            -- treated as a fresh unauthorized install with a grace window that
            -- can never be extended because it has no server record to extend.
            v_grace_ends := v_now;
        end if;

        if v_grace_ends > v_now then
            v_state := 'GRACE';
        else
            v_state := 'UNLICENSED';
        end if;
    end if;

    if v_state = 'GRACE' then
        v_days_remaining := greatest(0, ceil(extract(epoch from (v_grace_ends - v_now)) / 86400.0)::integer);
    end if;

    if v_identified and p_touch then
        update prosm_time_installations
        set last_seen_at = v_now,
            last_state = v_state,
            app_version = coalesce(nullif(trim(coalesce(p_app_version, '')), ''), app_version),
            updated_at = v_now
        where id = v_installation.id;
    end if;

    if v_state = 'UNLICENSED' and v_identified and v_installation.last_state is distinct from 'UNLICENSED' then
        perform prosm_time_record_security_event(
            v_installation.id, v_organization_id, 'GRACE_PERIOD_EXPIRED', p_operation, v_state, '{}'::jsonb
        );
    end if;

    if v_state = 'LICENSED' and v_identified and v_installation.last_state in ('GRACE', 'UNLICENSED', 'EXPIRED', 'SUSPENDED', 'BLOCKED', 'REVOKED') then
        perform prosm_time_record_security_event(
            v_installation.id, v_organization_id, 'INSTALLATION_RECOVERED', p_operation, v_state, '{}'::jsonb
        );
    end if;

    return jsonb_build_object(
        'success', true,
        'identified', v_identified,
        'installationId', v_installation.id,
        'organizationId', v_organization_id,
        'state', v_state,
        'allowed', v_state in ('LICENSED', 'GRACE'),
        'graceEndsAt', v_grace_ends,
        'graceDaysRemaining', v_days_remaining,
        'licenseStatus', v_license.status,
        'licenseExpiresAt', v_license.expires_at,
        'protectionVersion', (select active_version from prosm_time_protection_runtime where id = true),
        'serverTime', v_now
    );
end;
$function$;

revoke execute on function public.evaluate_prosm_time_installation(text, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.evaluate_prosm_time_installation(text, text, uuid, text, text, boolean) to service_role;

-- Client-facing validation (Edge Function validate-installation).
create or replace function public.validate_prosm_time_installation(
    p_installation_key text,
    p_installation_secret text,
    p_auth_user_id uuid default null,
    p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
    v_installation_id uuid;
begin
    v_result := evaluate_prosm_time_installation(
        p_installation_key, p_installation_secret, p_auth_user_id, p_app_version, 'validate', true
    );
    v_installation_id := nullif(v_result->>'installationId', '')::uuid;

    if v_installation_id is not null and p_auth_user_id is not null then
        insert into prosm_time_installation_sessions (installation_id, user_id, organization_id)
        select v_installation_id, u.id, u.organization_id from users u where u.auth_user_id = p_auth_user_id
        on conflict do nothing;

        update prosm_time_installation_sessions
        set last_seen_at = now()
        where installation_id = v_installation_id and ended_at is null;
    end if;

    if (v_result->>'identified')::boolean is not true then
        perform prosm_time_record_security_event(
            null, nullif(v_result->>'organizationId', '')::uuid, 'VALIDATION_FAILED', 'validate',
            v_result->>'state', '{}'::jsonb
        );
    end if;

    return v_result;
end;
$function$;

revoke execute on function public.validate_prosm_time_installation(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.validate_prosm_time_installation(text, text, uuid, text) to service_role;

-- The gate every protected PROSM Time operation calls.
create or replace function public.enforce_prosm_time_license_gate(
    p_operation text,
    p_installation_key text default null,
    p_installation_secret text default null,
    p_auth_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    if p_operation is null or length(trim(p_operation)) = 0 then
        raise exception 'OPERATION IS REQUIRED';
    end if;

    v_result := evaluate_prosm_time_installation(
        p_installation_key, p_installation_secret, p_auth_user_id, null, p_operation, true
    );

    if (v_result->>'allowed')::boolean is not true then
        perform prosm_time_record_security_event(
            nullif(v_result->>'installationId', '')::uuid,
            nullif(v_result->>'organizationId', '')::uuid,
            'PROTECTED_OPERATION_DENIED',
            p_operation,
            v_result->>'state',
            '{}'::jsonb
        );
    end if;

    return v_result;
end;
$function$;

revoke execute on function public.enforce_prosm_time_license_gate(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.enforce_prosm_time_license_gate(text, text, text, uuid) to service_role;

-- ============================================================
-- 8. Control-plane administration (service-to-service only)
-- ============================================================

create or replace function public.admin_set_prosm_time_installation_state(
    p_installation_key text,
    p_admin_state text,
    p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_installation prosm_time_installations%rowtype;
begin
    if p_admin_state not in ('NONE', 'SUSPENDED', 'BLOCKED', 'REVOKED') then
        raise exception 'INVALID INSTALLATION ADMIN STATE';
    end if;

    update prosm_time_installations
    set admin_state = p_admin_state, updated_at = now()
    where installation_key = p_installation_key
    returning * into v_installation;

    if not found then
        raise exception 'INSTALLATION NOT FOUND';
    end if;

    if p_admin_state in ('SUSPENDED', 'BLOCKED', 'REVOKED') then
        update prosm_time_installation_sessions
        set ended_at = now(), ended_reason = p_admin_state
        where installation_id = v_installation.id and ended_at is null;
    end if;

    perform prosm_time_record_security_event(
        v_installation.id, v_installation.organization_id,
        case p_admin_state
            when 'SUSPENDED' then 'INSTALLATION_SUSPENDED'
            when 'BLOCKED' then 'INSTALLATION_BLOCKED'
            when 'REVOKED' then 'INSTALLATION_REVOKED'
            else 'INSTALLATION_REINSTATED'
        end,
        null, p_admin_state, jsonb_build_object('reason', p_reason)
    );

    return jsonb_build_object('success', true, 'state', p_admin_state);
end;
$function$;

revoke execute on function public.admin_set_prosm_time_installation_state(text, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_prosm_time_installation_state(text, text, text) to service_role;

create or replace function public.terminate_prosm_time_installation_sessions(p_installation_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_installation prosm_time_installations%rowtype;
    v_count integer;
begin
    select * into v_installation from prosm_time_installations where installation_key = p_installation_key;
    if not found then
        raise exception 'INSTALLATION NOT FOUND';
    end if;

    update prosm_time_installation_sessions
    set ended_at = now(), ended_reason = 'TERMINATED_BY_CONTROL_PLANE'
    where installation_id = v_installation.id and ended_at is null;
    get diagnostics v_count = row_count;

    perform prosm_time_record_security_event(
        v_installation.id, v_installation.organization_id, 'SESSIONS_TERMINATED', null, null,
        jsonb_build_object('sessions', v_count)
    );

    return jsonb_build_object('success', true, 'terminated', v_count);
end;
$function$;

revoke execute on function public.terminate_prosm_time_installation_sessions(text) from public, anon, authenticated;
grant execute on function public.terminate_prosm_time_installation_sessions(text) to service_role;

create or replace function public.list_prosm_time_installations(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_rows jsonb;
begin
    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows
    from (
        select i.installation_key,
               i.organization_id,
               o.name as organization_name,
               i.platform,
               i.app_version,
               i.device_label,
               i.admin_state,
               i.last_state,
               i.grace_started_at,
               i.registered_at,
               i.last_seen_at,
               l.status as license_status,
               l.expires_at as license_expires_at,
               (select count(*) from prosm_time_installation_sessions s
                 where s.installation_id = i.id and s.ended_at is null) as active_sessions
        from prosm_time_installations i
        left join organizations o on o.id = i.organization_id
        left join license_activation_state l on l.organization_id = i.organization_id
        order by i.last_seen_at desc
        limit greatest(1, least(coalesce(p_limit, 200), 1000))
    ) t;

    return jsonb_build_object('success', true, 'installations', v_rows);
end;
$function$;

revoke execute on function public.list_prosm_time_installations(integer) from public, anon, authenticated;
grant execute on function public.list_prosm_time_installations(integer) to service_role;

create or replace function public.get_prosm_time_installation_history(p_installation_key text, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_installation prosm_time_installations%rowtype;
    v_events jsonb;
begin
    select * into v_installation from prosm_time_installations where installation_key = p_installation_key;
    if not found then
        raise exception 'INSTALLATION NOT FOUND';
    end if;

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_events
    from (
        select event_type, operation, state, detail, created_at
        from prosm_time_security_events
        where installation_id = v_installation.id
        order by created_at desc
        limit greatest(1, least(coalesce(p_limit, 100), 1000))
    ) t;

    return jsonb_build_object('success', true, 'events', v_events);
end;
$function$;

revoke execute on function public.get_prosm_time_installation_history(text, integer) from public, anon, authenticated;
grant execute on function public.get_prosm_time_installation_history(text, integer) to service_role;

-- ============================================================
-- 9. Protection-policy updates: validate -> stage -> activate -> rollback
-- ============================================================

-- The whitelist. Anything else in a payload is a malformed/unauthorized
-- update and is rejected outright, so an update can never switch enforcement,
-- authorization, auditing or RLS off.
create or replace function public.prosm_time_validate_protection_payload(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $function$
declare
    v_key text;
    v_allowed text[] := array['graceperioddays', 'validationintervalminutes', 'maxvalidationfailures', 'blockonunknowninstallation'];
begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        return 'PAYLOAD MUST BE A JSON OBJECT';
    end if;

    for v_key in select jsonb_object_keys(p_payload) loop
        if not (lower(v_key) = any (v_allowed)) then
            return 'UNSUPPORTED PROTECTION KEY: ' || v_key;
        end if;
    end loop;

    if p_payload ? 'graceperioddays' then
        if jsonb_typeof(p_payload->'graceperioddays') <> 'number'
           or (p_payload->>'graceperioddays')::numeric not between 1 and 365 then
            return 'GRACEPERIODDAYS OUT OF RANGE';
        end if;
    end if;

    if p_payload ? 'validationintervalminutes' then
        if jsonb_typeof(p_payload->'validationintervalminutes') <> 'number'
           or (p_payload->>'validationintervalminutes')::numeric not between 5 and 1440 then
            return 'VALIDATIONINTERVALMINUTES OUT OF RANGE';
        end if;
    end if;

    if p_payload ? 'maxvalidationfailures' then
        if jsonb_typeof(p_payload->'maxvalidationfailures') <> 'number'
           or (p_payload->>'maxvalidationfailures')::numeric not between 1 and 1000 then
            return 'MAXVALIDATIONFAILURES OUT OF RANGE';
        end if;
    end if;

    if p_payload ? 'blockonunknowninstallation'
       and jsonb_typeof(p_payload->'blockonunknowninstallation') <> 'boolean' then
        return 'BLOCKONUNKNOWNINSTALLATION MUST BE BOOLEAN';
    end if;

    return null;
end;
$function$;

revoke execute on function public.prosm_time_validate_protection_payload(jsonb) from public, anon, authenticated;
grant execute on function public.prosm_time_validate_protection_payload(jsonb) to service_role;

-- One atomic call: validate, stage, activate, keep the previous known-good
-- version for rollback. Any failure leaves the previously active policy in
-- place and records the failure.
create or replace function public.apply_prosm_time_protection_policy(
    p_version integer,
    p_payload jsonb,
    p_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_error text;
    v_active integer;
begin
    select active_version into v_active from prosm_time_protection_runtime where id = true for update;

    update prosm_time_protection_runtime set last_check_at = now(), updated_at = now() where id = true;

    if p_version is null or p_version <= 0 then
        v_error := 'INVALID PROTECTION VERSION';
    elsif v_active is not null and p_version <= v_active then
        v_error := 'PROTECTION VERSION IS NOT NEWER THAN THE ACTIVE VERSION';
    elsif p_checksum is null or length(trim(p_checksum)) = 0 then
        v_error := 'MISSING PROTECTION CHECKSUM';
    else
        v_error := prosm_time_validate_protection_payload(p_payload);
    end if;

    if v_error is not null then
        -- A rejected payload is never staged: nothing enters the policy
        -- table, so the active version cannot be touched by a bad update.
        -- The attempt itself is recorded below as a security event.
        update prosm_time_protection_runtime
        set last_failure_at = now(), last_failure_reason = v_error, updated_at = now()
        where id = true;

        perform prosm_time_record_security_event(
            null, null, 'PROTECTION_UPDATE_REJECTED', null, null,
            jsonb_build_object('version', p_version, 'reason', v_error)
        );

        return jsonb_build_object('success', false, 'error', v_error, 'activeVersion', v_active);
    end if;

    -- Stage first, then activate; both inside this one transaction, so the
    -- system is never partially updated.
    insert into prosm_time_protection_policies (version, payload, checksum, status)
    values (p_version, p_payload, p_checksum, 'STAGED')
    on conflict (version) do update set payload = excluded.payload, checksum = excluded.checksum,
        status = 'STAGED', staged_at = now(), rejected_reason = null;

    update prosm_time_protection_policies set status = 'SUPERSEDED' where status = 'ACTIVE';
    update prosm_time_protection_policies set status = 'ACTIVE', activated_at = now() where version = p_version;

    update prosm_time_protection_runtime
    set previous_version = v_active,
        active_version = p_version,
        last_success_at = now(),
        updated_at = now()
    where id = true;

    perform prosm_time_record_security_event(
        null, null, 'PROTECTION_UPDATE_ACTIVATED', null, null,
        jsonb_build_object('version', p_version, 'previousVersion', v_active)
    );

    return jsonb_build_object('success', true, 'activeVersion', p_version, 'previousVersion', v_active);
end;
$function$;

revoke execute on function public.apply_prosm_time_protection_policy(integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_prosm_time_protection_policy(integer, jsonb, text) to service_role;

create or replace function public.rollback_prosm_time_protection_policy(p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_active integer;
    v_previous integer;
begin
    select active_version, previous_version into v_active, v_previous
    from prosm_time_protection_runtime where id = true for update;

    if v_previous is null then
        return jsonb_build_object('success', false, 'error', 'NO PREVIOUS PROTECTION VERSION', 'activeVersion', v_active);
    end if;

    update prosm_time_protection_policies set status = 'ROLLED_BACK' where version = v_active;
    update prosm_time_protection_policies set status = 'ACTIVE', activated_at = now() where version = v_previous;

    update prosm_time_protection_runtime
    set active_version = v_previous, previous_version = null, last_rollback_at = now(),
        last_failure_reason = coalesce(p_reason, 'ROLLBACK'), updated_at = now()
    where id = true;

    perform prosm_time_record_security_event(
        null, null, 'PROTECTION_ROLLED_BACK', null, null,
        jsonb_build_object('from', v_active, 'to', v_previous, 'reason', p_reason)
    );

    return jsonb_build_object('success', true, 'activeVersion', v_previous, 'rolledBackFrom', v_active);
end;
$function$;

revoke execute on function public.rollback_prosm_time_protection_policy(text) from public, anon, authenticated;
grant execute on function public.rollback_prosm_time_protection_policy(text) to service_role;

create or replace function public.record_prosm_time_protection_check_failure(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_active integer;
begin
    select active_version into v_active from prosm_time_protection_runtime where id = true;

    update prosm_time_protection_runtime
    set last_check_at = now(), last_failure_at = now(),
        last_failure_reason = coalesce(p_reason, 'UNKNOWN'), updated_at = now()
    where id = true;

    perform prosm_time_record_security_event(
        null, null, 'PROTECTION_UPDATE_CHECK_FAILED', null, null,
        jsonb_build_object('reason', p_reason)
    );

    -- A failed check NEVER changes the active policy.
    return jsonb_build_object('success', false, 'activeVersion', v_active);
end;
$function$;

revoke execute on function public.record_prosm_time_protection_check_failure(text) from public, anon, authenticated;
grant execute on function public.record_prosm_time_protection_check_failure(text) to service_role;

create or replace function public.get_prosm_time_protection_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_runtime prosm_time_protection_runtime%rowtype;
begin
    select * into v_runtime from prosm_time_protection_runtime where id = true;

    return jsonb_build_object(
        'success', true,
        'activeVersion', v_runtime.active_version,
        'previousVersion', v_runtime.previous_version,
        'lastCheckAt', v_runtime.last_check_at,
        'lastSuccessAt', v_runtime.last_success_at,
        'lastFailureAt', v_runtime.last_failure_at,
        'lastFailureReason', v_runtime.last_failure_reason,
        'lastRollbackAt', v_runtime.last_rollback_at,
        'graceDays', prosm_time_effective_grace_days(),
        'payload', (select payload from prosm_time_protection_policies where status = 'ACTIVE')
    );
end;
$function$;

revoke execute on function public.get_prosm_time_protection_state() from public, anon, authenticated;
grant execute on function public.get_prosm_time_protection_state() to service_role;
