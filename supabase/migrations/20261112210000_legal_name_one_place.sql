-- Owner 2026-11-12: "the official name now has more than one place - it is enough when the person is added,
-- and from then on it goes by itself to every field that needs it". The name given at the invitation (or
-- corrected in the person's file) is the one: the salary card always takes it (it is no longer typed there),
-- and so the payroll cycles, payslips and reports. A card without one in the file (organisations from before)
-- keeps its own. When the payroll follows an Arab country's law the name is checked for Arabic where it is
-- given, not later at the salary card.
-- Rollback: restore set_prosm_time_user_legal_name and save_prosm_time_payroll_profile from
-- 20261112100000_legal_name_at_invite.sql.

begin;

do $patch$
declare
    v_def text;
    a text := '    update payroll_profiles set legal_name = (select legal_name from users where id = p_user_id) where id = v_id and legal_name is null;';
    b text := '    update users set legal_name = v_name, updated_at = now() where id = p_user_id;';
begin
    -- the salary card follows the person's file
    v_def := replace(pg_get_functiondef('public.save_prosm_time_payroll_profile(uuid,jsonb)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(a in v_def) = 0 then raise exception 'payroll legal name anchor not found'; end if;
    v_def := replace(v_def, a, '    update payroll_profiles set legal_name = coalesce((select legal_name from users where id = p_user_id), legal_name) where id = v_id;');
    execute v_def;

    -- checked where it is given
    v_def := replace(pg_get_functiondef('public.set_prosm_time_user_legal_name(uuid,text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(b in v_def) = 0 then raise exception 'user legal name anchor not found'; end if;
    v_def := replace(v_def, b, '    if v_name is not null and exists (select 1 from payroll_settings where organization_id = v_org)
       and public.prosm_time_payroll_name_in_arabic(v_org) and (v_name ~ ''[A-Za-z]'' or v_name !~ ''[؀-ۿ]'') then
        raise exception ''LEGAL NAME MUST BE IN ARABIC'';
    end if;
' || b);
    execute v_def;
end;
$patch$;

commit;
