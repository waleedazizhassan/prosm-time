-- Security per organisation (owner 2026-11-16: "I see no buttons to choose two-step verification for the sensitive
-- actions"). The two switches of 20261115130000 were platform-wide only. Now each organisation's owner chooses:
--   security_step_up - confirm your identity (sign-in within the last 10 minutes) before a sensitive action:
--                      approving / reopening payroll, publishing payslips, API keys, changing permissions,
--                      transferring ownership;
--   security_mfa     - and for the owner and the people who approve payroll or assign permissions, that
--                      confirmation is a two-step code (an authenticator app), not only the password.
-- The platform switch still turns either on for everyone. Turning a protection OFF needs a fresh confirmation (an
-- open session left on a desk cannot switch it off). Every change is written to the audit trail.
-- Rollback: re-run prosm_time_step_up_flag from 20261115130000; drop set_/get_prosm_time_security_policy and the two
-- organizations columns.

begin;

alter table public.organizations add column if not exists security_step_up boolean not null default false;
alter table public.organizations add column if not exists security_mfa boolean not null default false;

-- the platform switch, or the caller's organisation's own
create or replace function public.prosm_time_step_up_flag(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select value = 'true'::jsonb from platform_settings where key = p_key), false)
        or coalesce((
            select case p_key when 'step_up_required' then o.security_step_up or o.security_mfa
                              when 'mfa_required' then o.security_mfa
                              else false end
            from organizations o where o.id = public.current_prosm_time_organization_id()
        ), false);
$$;
revoke all on function public.prosm_time_step_up_flag(text) from public, anon, authenticated;

create or replace function public.get_prosm_time_security_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    return (select jsonb_build_object(
        'stepUp', o.security_step_up, 'mfa', o.security_mfa,
        'platformStepUp', coalesce((select value = 'true'::jsonb from platform_settings where key = 'step_up_required'), false),
        'platformMfa', coalesce((select value = 'true'::jsonb from platform_settings where key = 'mfa_required'), false),
        'canChange', exists (select 1 from users u where u.id = public.current_prosm_time_user_id() and u.is_owner))
        from organizations o where o.id = v_org);
end;
$$;
revoke all on function public.get_prosm_time_security_policy() from public, anon;
grant execute on function public.get_prosm_time_security_policy() to authenticated;

create or replace function public.set_prosm_time_security_policy(p_step_up boolean, p_mfa boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_old organizations%rowtype;
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if not exists (select 1 from users where id = v_me and is_owner) then raise exception 'ONLY THE ORGANIZATION OWNER'; end if;
    if p_step_up is null or p_mfa is null then raise exception 'INVALID REQUEST'; end if;
    select * into v_old from organizations where id = v_org for update;
    -- switching a protection off needs a fresh confirmation (while it is on, the check below asks for it)
    if (v_old.security_step_up and not p_step_up) or (v_old.security_mfa and not p_mfa) then
        perform public.prosm_time_require_step_up('security.change');
    end if;
    update organizations set security_step_up = p_step_up or p_mfa, security_mfa = p_mfa where id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, 'SECURITY_POLICY_CHANGED', 'organizations', v_org, 'The organisation''s security settings were changed',
            jsonb_build_object('stepUp', v_old.security_step_up, 'mfa', v_old.security_mfa),
            jsonb_build_object('stepUp', p_step_up or p_mfa, 'mfa', p_mfa));
    return jsonb_build_object('success', true, 'stepUp', p_step_up or p_mfa, 'mfa', p_mfa);
end;
$$;
revoke all on function public.set_prosm_time_security_policy(boolean, boolean) from public, anon;
grant execute on function public.set_prosm_time_security_policy(boolean, boolean) to authenticated;

commit;
