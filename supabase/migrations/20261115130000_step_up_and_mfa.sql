-- Governance phase C (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md section 14.3).
-- Step-up before the most sensitive actions, and MFA for the people who hold them.
--
-- Source of trust: the Supabase Auth JWT, whose signature PostgREST verifies before any function runs; the
-- claims are read with auth.jwt(). Nothing the client passes as an argument counts as proof.
--   aal  - 'aal1' one factor, 'aal2' a second factor (TOTP) verified in this session
--   amr  - [{method, timestamp}] each sign-in method used in this session and when (Unix seconds);
--          refreshing the token keeps these timestamps, so freshness cannot be renewed without signing in again.
-- prosm_time_require_step_up(action):
--   * a person who must use MFA (platform flag mfa_required on, plan with payroll, and the real owner or a holder
--     of payroll.approve / payroll.reopen / permissions.assign): aal2 and a 'totp' sign-in at most 600 s old;
--   * anyone else: a 'password', 'totp' or 'otp' sign-in at most 600 s old;
--   * a timestamp more than 60 s in the future is refused (clock skew allowance);
--   * a refusal raises STEP_UP_REQUIRED (or MFA_REQUIRED). A refusal rolls back with its request, so the app
--     records it with record_prosm_time_step_up_denied (STEP_UP_DENIED in the audit trail) when it receives it.
-- Enforcement is behind platform flags that start OFF, so nothing changes until the app with the confirmation
-- screen is in people's hands: step_up_required (freshness) and mfa_required (aal2 for the people above).
-- Guarded actions: approving and reopening a payroll cycle, publishing payslips, creating an API key.
-- Deactivating a person also ends their Supabase sessions (their refresh tokens stop working); the database
-- already refuses an inactive person's requests at once.
-- Rollback: drop prosm_time_require_step_up / prosm_time_user_requires_mfa / prosm_time_step_up_flag, delete the
-- two platform_settings rows, re-run the patched function bodies from 20261108130000 / 20261108150000 /
-- 20261115100000.

begin;

insert into public.platform_settings (key, value) values ('step_up_required', 'false'::jsonb) on conflict (key) do nothing;
insert into public.platform_settings (key, value) values ('mfa_required', 'false'::jsonb) on conflict (key) do nothing;

create or replace function public.prosm_time_step_up_flag(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select value = 'true'::jsonb from platform_settings where key = p_key), false);
$$;
revoke all on function public.prosm_time_step_up_flag(text) from public, anon, authenticated;

create or replace function public.prosm_time_user_requires_mfa(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_step_up_flag('mfa_required')
       and exists (select 1 from users u where u.id = p_user_id and u.is_active
                   and public.prosm_time_plan_allows(u.organization_id, 'payroll'))
       and (
           exists (select 1 from users where id = p_user_id and is_owner)
           or public.prosm_time_user_has_permission_internal(p_user_id, 'payroll.approve')
           or public.prosm_time_user_has_permission_internal(p_user_id, 'payroll.reopen')
           or public.prosm_time_user_has_permission_internal(p_user_id, 'permissions.assign')
       );
$$;
revoke all on function public.prosm_time_user_requires_mfa(uuid) from public, anon;
grant execute on function public.prosm_time_user_requires_mfa(uuid) to authenticated;

-- what the app asks before showing the confirmation screen (never a decision on its own)
create or replace function public.get_prosm_time_step_up_policy()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'stepUpRequired', public.prosm_time_step_up_flag('step_up_required'),
        'mfaRequired', public.prosm_time_user_requires_mfa(public.current_prosm_time_user_id()),
        'windowSeconds', 600);
$$;
revoke all on function public.get_prosm_time_step_up_policy() from public, anon;
grant execute on function public.get_prosm_time_step_up_policy() to authenticated;

create or replace function public.prosm_time_require_step_up(p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_claims jsonb := auth.jwt();
    v_me uuid := public.current_prosm_time_user_id();
    v_mfa boolean;
    v_methods text[];
    v_fresh numeric;
    v_now numeric := extract(epoch from clock_timestamp());
    v_reason text;
begin
    if not public.prosm_time_step_up_flag('step_up_required') and not public.prosm_time_step_up_flag('mfa_required') then
        return;
    end if;
    if v_me is null or v_claims is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    v_mfa := public.prosm_time_user_requires_mfa(v_me);
    if not v_mfa and not public.prosm_time_step_up_flag('step_up_required') then
        return;
    end if;
    v_methods := case when v_mfa then array['totp'] else array['password', 'totp', 'otp'] end;

    select max((m ->> 'timestamp')::numeric) into v_fresh
    from jsonb_array_elements(case when jsonb_typeof(v_claims -> 'amr') = 'array' then v_claims -> 'amr' else '[]'::jsonb end) m
    where m ->> 'method' = any(v_methods) and (m ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$';

    if v_mfa and coalesce(v_claims ->> 'aal', '') <> 'aal2' then
        v_reason := 'mfa_not_verified';
    elsif v_fresh is null then
        v_reason := 'no_recent_sign_in';
    elsif v_fresh > v_now + 60 then
        v_reason := 'sign_in_in_the_future';
    elsif v_now - v_fresh > 600 then
        v_reason := 'sign_in_too_old';
    end if;

    if v_reason is not null then
        -- the refusal itself rolls back with the request, so it is recorded by record_prosm_time_step_up_denied,
        -- which the app calls when it receives this error (and PostgREST's own log keeps the failed call)
        if v_mfa and coalesce(v_claims ->> 'aal', '') <> 'aal2' then
            raise exception 'MFA_REQUIRED';
        end if;
        raise exception 'STEP_UP_REQUIRED';
    end if;
end;
$$;
revoke all on function public.prosm_time_require_step_up(text) from public, anon, authenticated;

-- the app records a refusal it received (the refused request itself rolled back)
create or replace function public.record_prosm_time_step_up_denied(p_action text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_code not in ('STEP_UP_REQUIRED', 'MFA_REQUIRED') or p_action !~ '^[a-z_.]{3,40}$' then raise exception 'INVALID REQUEST'; end if;
    -- at most one row per person and action per minute
    if exists (select 1 from audit_logs where actor_user_id = v_me and action = 'STEP_UP_DENIED'
               and context ->> 'action' = p_action and created_at > now() - interval '1 minute') then
        return;
    end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description, reason, context)
    select organization_id, v_me, v_me, 'STEP_UP_DENIED', 'users', 'A sensitive action asked to confirm the identity first', p_code,
           jsonb_build_object('action', p_action, 'aal', auth.jwt() ->> 'aal')
    from users where id = v_me;
end;
$$;
revoke all on function public.record_prosm_time_step_up_denied(text, text) from public, anon;
grant execute on function public.record_prosm_time_step_up_denied(text, text) to authenticated;

-- the guarded actions -------------------------------------------------------------------------
do $$
declare
    v_def text;
    v_patches text[][] := array[
        array['public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)',
              E'    elsif p_action = ''approve'' then\n        perform public.prosm_time_payroll_require(''payroll.approve'', v_cycle.site_id);\n',
              E'        perform public.prosm_time_require_step_up(''payroll.approve'');\n'],
        array['public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)',
              E'    elsif p_action = ''reopen'' then\n        perform public.prosm_time_payroll_require(''payroll.reopen'', v_cycle.site_id);\n',
              E'        perform public.prosm_time_require_step_up(''payroll.reopen'');\n'],
        array['public.publish_prosm_time_payslips(uuid, boolean)',
              E'    perform public.prosm_time_payroll_require(''payroll.publish_payslips'', v_cycle.site_id);\n',
              E'    perform public.prosm_time_require_step_up(''payroll.publish_payslips'');\n'],
        array['public.generate_prosm_time_api_key_v2(text, text[], timestamp with time zone, text)',
              E'    if not public.current_prosm_time_user_is_real_owner() then raise exception ''ONLY THE ORGANIZATION OWNER MAY CREATE AN API KEY''; end if;\n',
              E'    perform public.prosm_time_require_step_up(''apikey.create'');\n']
    ];
    i integer;
begin
    for i in 1 .. array_length(v_patches, 1) loop
        v_def := replace(pg_get_functiondef(v_patches[i][1]::regprocedure), chr(13) || chr(10), chr(10));
        if position(v_patches[i][3] in v_def) > 0 then continue; end if;
        if position(v_patches[i][2] in v_def) = 0 then raise exception 'step-up: anchor not found in %', v_patches[i][1]; end if;
        execute replace(v_def, v_patches[i][2], v_patches[i][2] || v_patches[i][3]);
    end loop;
end $$;

-- deactivating a person ends their sessions (refresh tokens stop working) ----------------------
do $$
declare
    v_def text;
    v_anchor text := E'    update users\n    set is_active = false, deactivated_at = now(), deactivated_by = v_caller_id, deactivation_reason = trim(p_reason)\n    where id = p_user_id;\n';
    v_add text := E'    -- governance phase C: end the person''s sessions too\n'
        || E'    begin\n'
        || E'        delete from auth.sessions where user_id = v_target.auth_user_id;\n'
        || E'    exception when insufficient_privilege or undefined_table then\n'
        || E'        null; -- the database already refuses an inactive person; the token expires on its own\n'
        || E'    end;\n';
begin
    v_def := replace(pg_get_functiondef('public.deactivate_prosm_time_employee(uuid, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('delete from auth.sessions' in v_def) > 0 then return; end if;
    if position(v_anchor in v_def) = 0 then raise exception 'deactivate: anchor not found'; end if;
    execute replace(v_def, v_anchor, v_anchor || v_add);
end $$;

commit;
