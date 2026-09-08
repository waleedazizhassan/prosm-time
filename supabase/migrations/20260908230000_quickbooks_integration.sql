-- PROSM Time - real QuickBooks Online integration, the payroll-system
-- gap this session's own competitive research flagged (deferred until
-- the user could get real Intuit developer credentials - now
-- provided). Unlike the PROSM Projects bridge (a read-only API PROSM
-- Time exposes), this is the reverse direction: PROSM Time itself
-- connects OUT to each organization's own QuickBooks Online company
-- via real OAuth2, and pushes verified attendance as QuickBooks
-- TimeActivity entries.
--
-- Tokens are never exposed to the client at all - no RLS SELECT grant
-- on quickbooks_connections whatsoever (unlike api_keys/prosm_time_
-- integrations elsewhere, which are select-able but masked). A status
-- RPC is the only way the frontend ever learns anything about the
-- connection; the actual access_token/refresh_token only ever move
-- between this database and Intuit's own token endpoint, both via
-- service-role Edge Functions.
--
-- quickbooks_oauth_states exists because the OAuth callback (Intuit
-- redirects the browser here directly, no PROSM Time session at all at
-- that point - verify_jwt=false) needs to know WHICH organization
-- initiated the flow. A short-lived, single-use random state value
-- generated at authorize-start time and looked up (then deleted) at
-- callback time is the standard OAuth2 CSRF-prevention mechanism,
-- doing double duty as that org lookup here.

begin;

create table public.quickbooks_connections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    realm_id text not null,
    company_name text,
    access_token text not null,
    refresh_token text not null,
    access_token_expires_at timestamptz not null,
    refresh_token_expires_at timestamptz not null,
    enabled boolean not null default true,
    connected_by uuid references public.users(id) on delete set null,
    connected_at timestamptz not null default now(),
    last_synced_at timestamptz,
    last_sync_summary jsonb,
    updated_at timestamptz not null default now()
);

alter table public.quickbooks_connections enable row level security;
-- Deliberately NO grants at all to anon/authenticated - not even
-- select. Every real interaction goes through a status RPC or a
-- service-role Edge Function; the raw row (tokens included) must never
-- reach PostgREST for any role.
revoke all on public.quickbooks_connections from anon, authenticated;

create table public.quickbooks_oauth_states (
    state text primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

alter table public.quickbooks_oauth_states enable row level security;
revoke all on public.quickbooks_oauth_states from anon, authenticated;

-- Owner-only, starts the OAuth flow: mints a short-lived state row so
-- the (session-less) callback can recover which organization initiated
-- this. The actual Intuit authorize URL is assembled client-side
-- (QUICKBOOKS_CLIENT_ID and the redirect URI are both public-safe -
-- OAuth2 authorization requests never carry the client secret) - this
-- RPC's only job is minting a real, DB-backed, single-use state value,
-- not building the URL.
create or replace function public.start_prosm_time_quickbooks_connection()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_state text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CONNECT QUICKBOOKS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_state := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

    delete from quickbooks_oauth_states where organization_id = v_org;
    insert into quickbooks_oauth_states (state, organization_id, created_by, expires_at)
    values (v_state, v_org, v_caller_id, now() + interval '10 minutes');

    return jsonb_build_object('success', true, 'state', v_state);
exception
    when others then
        raise exception 'START PROSM TIME QUICKBOOKS CONNECTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.disconnect_prosm_time_quickbooks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY DISCONNECT QUICKBOOKS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    delete from quickbooks_connections where organization_id = v_org;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'QUICKBOOKS_DISCONNECTED', 'quickbooks_connections', v_org, 'Disconnected the QuickBooks Online integration.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DISCONNECT PROSM TIME QUICKBOOKS FAILED: %', sqlerrm;
end;
$function$;

-- Status view for the Settings UI - never returns any token, only
-- whether a connection exists and its non-sensitive metadata.
create or replace function public.get_prosm_time_quickbooks_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_row quickbooks_connections%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY VIEW THE QUICKBOOKS CONNECTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_row from quickbooks_connections where organization_id = v_org;

    if v_row.id is null then
        return jsonb_build_object('connected', false, 'companyName', null, 'enabled', false, 'lastSyncedAt', null, 'lastSyncSummary', null);
    end if;

    return jsonb_build_object(
        'connected', true,
        'companyName', v_row.company_name,
        'enabled', v_row.enabled,
        'connectedAt', v_row.connected_at,
        'lastSyncedAt', v_row.last_synced_at,
        'lastSyncSummary', v_row.last_sync_summary
    );
exception
    when others then
        raise exception 'GET PROSM TIME QUICKBOOKS STATUS FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.start_prosm_time_quickbooks_connection() from public, anon;
revoke execute on function public.disconnect_prosm_time_quickbooks() from public, anon;
revoke execute on function public.get_prosm_time_quickbooks_status() from public, anon;

commit;
