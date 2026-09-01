-- PROSM Time - live UX review, user-directed: "there should be a
-- password-reset feature - look at PROSM Platform's own pattern and
-- reuse it." Platform's own request-password-reset/verify-password-
-- reset/reset-password is a heavier SUPER_ADMIN-gated 3-step OTP
-- system; the pattern actually worth reusing here is the one PROSM
-- Time already built for itself in WP-04 (user_invitations +
-- create_invited_prosm_time_user/redeem_prosm_time_invitation +
-- redeem-invitation Edge Function) - a 6-digit emailed code, a
-- service_role-only table, and a SECURITY DEFINER RPC pair. This
-- migration is that same shape, one table over, for a lost password
-- instead of a first-time invitation.
--
-- Self-service, no session required (mirrors activate-organization/
-- redeem-invitation's verify_jwt=false posture) - this is exactly the
-- "I forgot my password and can't sign in" case.

begin;

create table public.password_reset_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    verification_code text not null,
    status text not null default 'PENDING' check (status in ('PENDING', 'CONSUMED', 'EXPIRED')),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    consumed_at timestamptz
);

create index password_reset_requests_user_id_idx on public.password_reset_requests(user_id);

alter table public.password_reset_requests enable row level security;

-- No authenticated/anon policy at all, by design - every access goes
-- through the two SECURITY DEFINER RPCs below, called only from the
-- service-role Edge Functions (request-password-reset/reset-password),
-- exactly like user_invitations already does.
revoke all on public.password_reset_requests from anon, authenticated;

-- ============================================================
-- request_prosm_time_password_reset - looks up an ACTIVE user by
-- email and records a fresh reset request. Returns success:false
-- (never raises) when no such active account exists, so the calling
-- Edge Function can respond with the same generic "if an account
-- exists..." message either way - no email-enumeration signal.
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

    insert into password_reset_requests (user_id, verification_code, status, expires_at)
    values (v_user.id, p_verification_code, 'PENDING', p_expires_at);

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'PASSWORD_RESET_REQUESTED', 'users', v_user.id, v_user.email || ' requested a password reset.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id, 'fullName', v_user.full_name, 'organizationId', v_user.organization_id);
exception
    when others then
        raise exception 'REQUEST PROSM TIME PASSWORD RESET FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- redeem_prosm_time_password_reset - validates the emailed code
-- (same PENDING/expiry/match checks as redeem_prosm_time_invitation)
-- and marks it CONSUMED. The actual Auth password update happens in
-- the calling Edge Function (service role, auth.admin.updateUserById)
-- - this RPC only ever touches public schema rows, same division of
-- labor as redeem-invitation.
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
begin
    select * into v_user from users where email = lower(trim(p_email)) and status = 'active';
    if v_user.id is null then
        raise exception 'NO ACCOUNT FOUND FOR THIS EMAIL';
    end if;

    select * into v_request from password_reset_requests
    where user_id = v_user.id and status = 'PENDING'
    order by created_at desc
    limit 1;

    if v_request.id is null then
        raise exception 'NO PENDING PASSWORD RESET REQUEST FOUND FOR THIS EMAIL';
    end if;

    if v_request.expires_at <= now() then
        update password_reset_requests set status = 'EXPIRED' where id = v_request.id;
        raise exception 'THIS RESET CODE HAS EXPIRED';
    end if;

    if v_request.verification_code <> p_verification_code then
        raise exception 'INVALID VERIFICATION CODE';
    end if;

    update password_reset_requests set status = 'CONSUMED', consumed_at = now() where id = v_request.id;

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'PASSWORD_RESET_REDEEMED', 'users', v_user.id, v_user.email || ' reset their password.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id);
exception
    when others then
        raise exception 'REDEEM PROSM TIME PASSWORD RESET FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.request_prosm_time_password_reset(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.request_prosm_time_password_reset(text, text, timestamptz) to service_role;

revoke execute on function public.redeem_prosm_time_password_reset(text, text) from public, anon, authenticated;
grant execute on function public.redeem_prosm_time_password_reset(text, text) to service_role;

commit;
