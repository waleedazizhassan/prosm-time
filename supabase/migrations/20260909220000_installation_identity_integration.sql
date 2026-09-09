-- PROSM Time - minimal integration-contract addition for the Anti-Crack
-- & Unauthorized Installation spec (user-directed, centralized in
-- Platform Management - see that project's own
-- 20260909210000_installation_identity_and_anti_crack.sql). Per the
-- spec's own point 15 ("لا تغيّر PROSM Time إلا لإضافة الـintegration
-- contracts الضرورية"), this is the ONLY schema PROSM Time gets: a
-- local, non-authoritative cache of this organization's own
-- installation identity + last-known license-gate state, mirroring
-- license_activation_state's own exact "cache locally, source of truth
-- is Platform Management" shape (20260831110000).
--
-- The installation secret is stored here in plaintext (never hashed
-- locally - Platform Management hashes and compares it on its own side)
-- because PROSM Time's own server-side Edge Functions need to present
-- it on every validate call. It must NEVER reach the browser/app
-- client: no grant to authenticated at all on this table - only a
-- dedicated status-only RPC exposes the non-secret display fields.
--
-- Deliberately NOT enforcement-wired yet: this migration only builds
-- register+cache+read-status. Actually gating a protected endpoint
-- (clock-in etc.) on this state is a separate, even-more-careful next
-- step, per the user's own explicit instruction to keep this pass to
-- the minimal foundation.

begin;

create table public.installation_identity (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    installation_key text not null unique,
    installation_secret text not null,
    platform text not null check (platform in ('web', 'android', 'windows')),
    app_version text not null,
    state text not null default 'ACTIVE' check (state in ('ACTIVE', 'GRACE', 'BLOCKED', 'UNREGISTERED')),
    grace_ends_at timestamptz,
    message text,
    outdated_version boolean not null default false,
    last_synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.installation_identity enable row level security;
-- No grants to anon/authenticated at all - the secret lives here.
-- Only service_role (this repo's own Edge Functions) and the
-- status-only RPC below ever touch this table.
revoke all on public.installation_identity from anon, authenticated;

-- Read-only, non-secret status for the organization's own members (the
-- eventual LicenseWarningBanner-equivalent UI reads this, never the
-- table directly).
create or replace function public.get_prosm_time_installation_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_row installation_identity%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_row from installation_identity where organization_id = v_org;

    if v_row.id is null then
        return jsonb_build_object('registered', false, 'state', null, 'graceEndsAt', null, 'message', null, 'outdatedVersion', false);
    end if;

    return jsonb_build_object(
        'registered', true,
        'state', v_row.state,
        'graceEndsAt', v_row.grace_ends_at,
        'message', v_row.message,
        'outdatedVersion', v_row.outdated_version,
        'lastSyncedAt', v_row.last_synced_at
    );
exception
    when others then
        raise exception 'GET PROSM TIME INSTALLATION STATUS FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.get_prosm_time_installation_status() from public, anon;

-- service_role-only read/write surface for the sync Edge Function -
-- matches this codebase's own established convention (every other
-- service-role Edge Function goes through a dedicated RPC, never a
-- direct table read/write - see e.g. authenticate_prosm_time_api_key,
-- get_prosm_time_quickbooks_connection_for_sync).
create or replace function public.get_prosm_time_installation_credentials(p_organization_id uuid)
returns table (installation_key text, installation_secret text)
language plpgsql
security definer
set search_path = public
as $function$
begin
    return query select ii.installation_key, ii.installation_secret from installation_identity ii where ii.organization_id = p_organization_id;
end;
$function$;

create or replace function public.upsert_prosm_time_installation_identity(
    p_organization_id uuid,
    p_installation_key text,
    p_installation_secret text,
    p_platform text,
    p_app_version text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    insert into installation_identity (organization_id, installation_key, installation_secret, platform, app_version, last_synced_at, updated_at)
    values (p_organization_id, p_installation_key, p_installation_secret, p_platform, p_app_version, now(), now())
    on conflict (organization_id) do update set
        installation_key = excluded.installation_key,
        installation_secret = excluded.installation_secret,
        platform = excluded.platform,
        app_version = excluded.app_version,
        updated_at = now();
end;
$function$;

create or replace function public.record_prosm_time_installation_evaluation(
    p_organization_id uuid,
    p_state text,
    p_grace_ends_at timestamptz,
    p_message text,
    p_outdated_version boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    update installation_identity
    set state = p_state, grace_ends_at = p_grace_ends_at, message = p_message,
        outdated_version = coalesce(p_outdated_version, false), last_synced_at = now(), updated_at = now()
    where organization_id = p_organization_id;
end;
$function$;

revoke execute on function public.get_prosm_time_installation_credentials(uuid) from public, anon, authenticated;
revoke execute on function public.upsert_prosm_time_installation_identity(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.record_prosm_time_installation_evaluation(uuid, text, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.get_prosm_time_installation_credentials(uuid) to service_role;
grant execute on function public.upsert_prosm_time_installation_identity(uuid, text, text, text, text) to service_role;
grant execute on function public.record_prosm_time_installation_evaluation(uuid, text, timestamptz, text, boolean) to service_role;

commit;
