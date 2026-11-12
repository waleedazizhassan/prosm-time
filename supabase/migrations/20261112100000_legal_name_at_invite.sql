-- Owner 2026-11-12: inviting an employee asks for the full legal name (four-part, as written on official
-- papers) under the short name. The short name stays the account's name everywhere in the app; the legal
-- name is used for the payslip, payroll reports and any official paper.
--
-- * users.legal_name, set right after the invitation by whoever invited (authority over the person) or by
--   personnel managers, and editable in the person's file;
-- * the salary card follows it (and one created later takes it); the payroll still requires one.
-- Not live until the owner approves (HR suite branch).
--
-- Rollback: drop set_prosm_time_user_legal_name; restore get_prosm_time_employee_profile and
-- save_prosm_time_payroll_profile from 20261111200000 / 20261110190000; drop users.legal_name.

begin;

alter table public.users add column if not exists legal_name text check (legal_name is null or length(trim(legal_name)) between 3 and 200);

create or replace function public.set_prosm_time_user_legal_name(p_user_id uuid, p_legal_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_name text := nullif(regexp_replace(trim(coalesce(p_legal_name, '')), '\s+', ' ', 'g'), '');
    v_old text;
begin
    select legal_name into v_old from users where id = p_user_id and organization_id = v_org;
    if not found then raise exception 'NOT FOUND'; end if;
    if not (public.prosm_time_caller_has_authority_over(p_user_id) or public.prosm_time_is_hr()) then raise exception 'PERMISSION DENIED'; end if;
    if v_name is not null and length(v_name) < 3 then raise exception 'ENTER THE FULL LEGAL NAME'; end if;
    update users set legal_name = v_name, updated_at = now() where id = p_user_id;
    -- one official name: the salary card follows it (an Arab country's payroll still checks it is in Arabic)
    update payroll_profiles set legal_name = v_name where user_id = p_user_id and v_name is not null and legal_name is distinct from v_name;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'hr.legal_name_set', 'users', p_user_id, 'Official (legal) name set',
            jsonb_build_object('legalName', v_old), jsonb_build_object('legalName', v_name));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_user_legal_name(uuid, text) from public, anon;
grant execute on function public.set_prosm_time_user_legal_name(uuid, text) to authenticated;

-- the file shows the legal name (the salary card's, else the one given at the invitation)
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.get_prosm_time_employee_profile(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    v_anchor text := '''legalName'', case when v_access in (''full'', ''self'') then (select legal_name from payroll_profiles where user_id = v_u.id) end),';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'profile legal name anchor not found'; end if;
    v_def := replace(v_def, v_anchor,
        '''legalName'', coalesce(v_u.legal_name, (select legal_name from payroll_profiles where user_id = v_u.id))),');
    execute v_def;
end;
$patch$;

-- the salary card takes the invitation's legal name when it has none
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.save_prosm_time_payroll_profile(uuid,jsonb)'::regprocedure), chr(13) || chr(10), chr(10));
    v_anchor text := '    if (select legal_name from payroll_profiles where id = v_id) is null then raise exception ''LEGAL NAME IS REQUIRED''; end if;';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'payroll legal name anchor not found'; end if;
    v_def := replace(v_def, v_anchor, '    update payroll_profiles set legal_name = (select legal_name from users where id = p_user_id) where id = v_id and legal_name is null;
' || v_anchor);
    execute v_def;
end;
$patch$;

commit;
