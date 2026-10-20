-- Security review M6, owner 2026-10-20. An invitation's 6-digit code was
-- stored in plain text, had no limit of its own on wrong guesses (only the
-- per-email/per-IP rate limits of the endpoint), and the answer told a
-- stranger whether an email had a pending invitation. Guessing the code
-- sets the account's password, so:
-- 1. the code is stored hashed (bcrypt) - every path that writes it is
--    covered by a trigger, and the pending ones are hashed now;
-- 2. five wrong codes lock the invitation (the administrator resends it);
-- 3. every failure gives the same answer, "INVALID VERIFICATION CODE".

begin;

alter table public.user_invitations add column if not exists failed_attempts integer not null default 0;
alter table public.user_invitations drop constraint if exists user_invitations_status_check;
alter table public.user_invitations add constraint user_invitations_status_check check (status in ('PENDING', 'CONSUMED', 'EXPIRED', 'LOCKED'));

create or replace function public.prosm_time_hash_invitation_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if new.verification_code is not null and left(new.verification_code, 4) <> '$2a$' then
        new.verification_code := extensions.crypt(new.verification_code, extensions.gen_salt('bf'));
    end if;
    return new;
end;
$function$;

revoke all on function public.prosm_time_hash_invitation_code() from public, anon, authenticated;

drop trigger if exists user_invitations_hash_code on public.user_invitations;
create trigger user_invitations_hash_code
before insert or update of verification_code on public.user_invitations
for each row execute function public.prosm_time_hash_invitation_code();

update public.user_invitations set verification_code = verification_code where status = 'PENDING';

create or replace function public.redeem_prosm_time_invitation(
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
    v_invitation user_invitations%rowtype;
begin
    select * into v_user from users where email = lower(trim(p_email)) and status = 'invited';
    select * into v_invitation from user_invitations where user_id = v_user.id;

    if v_user.id is null or v_invitation.id is null or v_invitation.status <> 'PENDING' then
        return jsonb_build_object('success', false, 'error', 'INVALID VERIFICATION CODE');
    end if;

    if v_invitation.expires_at <= now() then
        update user_invitations set status = 'EXPIRED' where id = v_invitation.id;
        return jsonb_build_object('success', false, 'error', 'INVALID VERIFICATION CODE');
    end if;

    -- A wrong code is counted (no exception, so the count is kept); the fifth locks it.
    if p_verification_code is null or extensions.crypt(p_verification_code, v_invitation.verification_code) <> v_invitation.verification_code then
        update user_invitations
        set failed_attempts = failed_attempts + 1,
            status = case when failed_attempts + 1 >= 5 then 'LOCKED' else status end
        where id = v_invitation.id;
        if v_invitation.failed_attempts + 1 >= 5 then
            insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
            values (v_user.organization_id, v_user.id, 'USER_INVITATION_LOCKED', 'users', v_user.id, 'Invitation locked after 5 wrong codes.');
        end if;
        return jsonb_build_object('success', false, 'error', 'INVALID VERIFICATION CODE');
    end if;

    update user_invitations set status = 'CONSUMED', consumed_at = now() where id = v_invitation.id;
    update users set status = 'active', updated_at = now() where id = v_user.id;

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'USER_INVITATION_REDEEMED', 'users', v_user.id, v_user.email || ' redeemed their invitation and set their password.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id);
end;
$function$;

revoke execute on function public.redeem_prosm_time_invitation(text, text) from public, anon, authenticated;
grant execute on function public.redeem_prosm_time_invitation(text, text) to service_role;

commit;
