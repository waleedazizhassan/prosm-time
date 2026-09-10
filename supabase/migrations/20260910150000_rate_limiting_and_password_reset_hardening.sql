-- PROSM Time - real gap found in the 14-point live-audit: no rate
-- limiting or security headers existed on any session-less Edge
-- Function. Cherry-picked (not merged wholesale - see this session's
-- own notes on why that branch cannot be merged as a whole) from the
-- real, sound rate-limiting work that already existed, unmerged, on
-- hardening/password-reset-and-public-endpoints - verified against
-- current main's schema/RPC signatures before bringing it over
-- (nothing here had diverged since that branch was cut).
--
-- Server-side enforcement only; no product flow, UI or architecture
-- change. What this migration adds, and why:
--   1. security_rate_limits + consume_prosm_time_rate_limit() - a real,
--      server-side, service_role-only rate limiter shared by every
--      session-less Edge Function (request-password-reset,
--      reset-password, redeem-invitation, activate-organization,
--      export-attendance). Rate limiting cannot live in the client.
--   2. password_reset_requests now stores a SHA-256 hash of the emailed
--      code (never the plaintext) and counts failed attempts, so a code
--      cannot be brute-forced and a database reader cannot use a code.
--   3. request/redeem RPCs rewritten to: invalidate previous PENDING
--      codes, enforce expiry, enforce single use, lock the request out
--      after too many wrong attempts, and return the SAME neutral
--      failure shape for "no such account", "wrong code", "expired
--      code" and "locked out" - no user-enumeration signal.
--
-- Existing PENDING plaintext codes are expired here: they were stored
-- in the clear and must not stay redeemable. Affected users simply
-- request a new code through the unchanged UI.

begin;

-- ============================================================
-- 1. Shared server-side rate limiter
-- ============================================================
create table if not exists public.security_rate_limits (
    scope text not null,
    identifier text not null,
    window_started_at timestamptz not null default now(),
    attempt_count integer not null default 0,
    blocked_until timestamptz,
    updated_at timestamptz not null default now(),
    primary key (scope, identifier)
);

create index if not exists security_rate_limits_updated_at_idx on public.security_rate_limits(updated_at);

alter table public.security_rate_limits enable row level security;

-- No anon/authenticated access at all, by design: the limiter is only
-- ever consumed by service-role Edge Functions through the RPC below.
revoke all on public.security_rate_limits from anon, authenticated;
grant all on public.security_rate_limits to service_role;

create or replace function public.consume_prosm_time_rate_limit(
    p_scope text,
    p_identifier text,
    p_limit integer,
    p_window_seconds integer,
    p_block_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row public.security_rate_limits%rowtype;
    v_now timestamptz := now();
    v_identifier text := lower(coalesce(nullif(trim(p_identifier), ''), 'unknown'));
    v_block_seconds integer := coalesce(p_block_seconds, p_window_seconds);
begin
    insert into public.security_rate_limits (scope, identifier, window_started_at, attempt_count)
    values (p_scope, v_identifier, v_now, 0)
    on conflict (scope, identifier) do nothing;

    select * into v_row from public.security_rate_limits
    where scope = p_scope and identifier = v_identifier
    for update;

    if v_row.blocked_until is not null and v_row.blocked_until > v_now then
        return jsonb_build_object(
            'allowed', false,
            'retryAfterSeconds', ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer
        );
    end if;

    -- Window elapsed (or a previous block just expired): start fresh.
    if v_row.window_started_at + make_interval(secs => p_window_seconds) <= v_now
       or v_row.blocked_until is not null then
        update public.security_rate_limits
        set window_started_at = v_now, attempt_count = 1, blocked_until = null, updated_at = v_now
        where scope = p_scope and identifier = v_identifier;
        return jsonb_build_object('allowed', true, 'remaining', greatest(p_limit - 1, 0));
    end if;

    if v_row.attempt_count >= p_limit then
        update public.security_rate_limits
        set blocked_until = v_now + make_interval(secs => v_block_seconds), updated_at = v_now
        where scope = p_scope and identifier = v_identifier;
        return jsonb_build_object('allowed', false, 'retryAfterSeconds', v_block_seconds);
    end if;

    update public.security_rate_limits
    set attempt_count = v_row.attempt_count + 1, updated_at = v_now
    where scope = p_scope and identifier = v_identifier;

    return jsonb_build_object('allowed', true, 'remaining', greatest(p_limit - v_row.attempt_count - 1, 0));
end;
$function$;

revoke execute on function public.consume_prosm_time_rate_limit(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_prosm_time_rate_limit(text, text, integer, integer, integer) to service_role;

-- ============================================================
-- 2. Password reset requests: hashed codes + attempt counter
-- ============================================================
alter table public.password_reset_requests
    add column if not exists code_hash text,
    add column if not exists attempt_count integer not null default 0;

alter table public.password_reset_requests
    alter column verification_code drop not null;

alter table public.password_reset_requests
    drop constraint if exists password_reset_requests_status_check;

alter table public.password_reset_requests
    add constraint password_reset_requests_status_check
    check (status in ('PENDING', 'CONSUMED', 'EXPIRED', 'LOCKED'));

-- Any code that was stored in plaintext is retired, not migrated.
update public.password_reset_requests
set status = 'EXPIRED', verification_code = null
where status = 'PENDING';

update public.password_reset_requests
set verification_code = null
where verification_code is not null;

create index if not exists password_reset_requests_user_status_idx
    on public.password_reset_requests(user_id, status);

create or replace function public.hash_prosm_time_reset_code(p_user_id uuid, p_code text)
returns text
language sql
immutable
security definer
set search_path = public
as $function$
    select encode(sha256(convert_to(p_user_id::text || ':' || p_code, 'UTF8')), 'hex');
$function$;

revoke execute on function public.hash_prosm_time_reset_code(uuid, text) from public, anon, authenticated;
grant execute on function public.hash_prosm_time_reset_code(uuid, text) to service_role;

-- ============================================================
-- 3. request_prosm_time_password_reset - unchanged contract, hashed
--    storage, previous PENDING codes invalidated.
-- ============================================================
create or replace function public.request_prosm_time_password_reset(
    p_email text,
    p_verification_code text,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user users%rowtype;
begin
    select * into v_user from users where email = lower(trim(p_email)) and status = 'active';
    if v_user.id is null then
        return jsonb_build_object('success', false, 'reason', 'NO_ACTIVE_ACCOUNT');
    end if;

    -- One live code per account: issuing a new one retires the old one.
    update password_reset_requests
    set status = 'EXPIRED'
    where user_id = v_user.id and status = 'PENDING';

    insert into password_reset_requests (user_id, verification_code, code_hash, status, expires_at)
    values (v_user.id, null, public.hash_prosm_time_reset_code(v_user.id, p_verification_code), 'PENDING', p_expires_at);

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'PASSWORD_RESET_REQUESTED', 'users', v_user.id, v_user.email || ' requested a password reset.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id, 'fullName', v_user.full_name, 'organizationId', v_user.organization_id);
exception
    when others then
        raise exception 'REQUEST PROSM TIME PASSWORD RESET FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- 4. redeem_prosm_time_password_reset - neutral failures, expiry,
--    single use, brute-force lockout.
--
--    Behaviour change that matters: this RPC no longer raises a
--    describing exception ("NO ACCOUNT FOUND", "INVALID VERIFICATION
--    CODE", "THIS RESET CODE HAS EXPIRED"). Every user-caused failure
--    returns success:false with the same neutral reason, so the caller
--    cannot tell an unknown email from a wrong code.
-- ============================================================
create or replace function public.redeem_prosm_time_password_reset(
    p_email text,
    p_verification_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user users%rowtype;
    v_request password_reset_requests%rowtype;
    v_max_attempts constant integer := 5;
begin
    select * into v_user from users where email = lower(trim(p_email)) and status = 'active';
    if v_user.id is null then
        return jsonb_build_object('success', false, 'reason', 'INVALID_OR_EXPIRED');
    end if;

    select * into v_request from password_reset_requests
    where user_id = v_user.id and status = 'PENDING'
    order by created_at desc
    limit 1
    for update;

    if v_request.id is null then
        return jsonb_build_object('success', false, 'reason', 'INVALID_OR_EXPIRED');
    end if;

    if v_request.expires_at <= now() then
        update password_reset_requests set status = 'EXPIRED' where id = v_request.id;
        return jsonb_build_object('success', false, 'reason', 'INVALID_OR_EXPIRED');
    end if;

    if v_request.code_hash is null
       or v_request.code_hash <> public.hash_prosm_time_reset_code(v_user.id, trim(p_verification_code)) then
        update password_reset_requests
        set attempt_count = v_request.attempt_count + 1,
            status = case when v_request.attempt_count + 1 >= v_max_attempts then 'LOCKED' else status end
        where id = v_request.id;
        return jsonb_build_object('success', false, 'reason', 'INVALID_OR_EXPIRED');
    end if;

    update password_reset_requests
    set status = 'CONSUMED', consumed_at = now(), code_hash = null
    where id = v_request.id;

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'PASSWORD_RESET_REDEEMED', 'users', v_user.id, v_user.email || ' reset their password.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id);
end;
$function$;

revoke execute on function public.request_prosm_time_password_reset(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.request_prosm_time_password_reset(text, text, timestamptz) to service_role;

revoke execute on function public.redeem_prosm_time_password_reset(text, text) from public, anon, authenticated;
grant execute on function public.redeem_prosm_time_password_reset(text, text) to service_role;

commit;
