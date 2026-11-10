-- 2026-11-10 (owner): "the employee's salary card asks for the name in the language of the country it
-- follows, and it is required - in Egypt the employee's name in Arabic - and that is the name on the
-- payslip, not the user's English name; a user may be registered under a nickname, not a real name."
--   * payroll_profiles.legal_name: the person's official name for payroll.
--   * Saving a salary card requires it; when the payroll follows an Arab country's law it must be
--     written in Arabic letters (no Latin letters).
--   * Every cycle line for the person carries this name (payslips, exports, reports): set when the
--     person is added to a cycle, and when the name changes the open cycles (draft / reopened) follow.
--     Approved and locked cycles keep the name they were approved with.
-- Rollback: drop the two triggers and their functions; restore save_prosm_time_payroll_profile from
-- 20261109240000; drop column payroll_profiles.legal_name.

begin;

alter table public.payroll_profiles add column if not exists legal_name text;

-- Arab League countries: the official name is written in Arabic
create or replace function public.prosm_time_payroll_name_in_arabic(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select country_code from payroll_settings where organization_id = p_org), 'EG')
        = any (array['EG','SA','SD','IQ','SY','YE','KW','QA','BH','OM','JO','LB','PS','AE','MA','DZ','TN','LY','MR','SO','DJ','KM']);
$$;
revoke all on function public.prosm_time_payroll_name_in_arabic(uuid) from public, anon, authenticated;

do $patch$
declare
    v_def text := pg_get_functiondef('public.save_prosm_time_payroll_profile(uuid,jsonb)'::regprocedure);
    a text := '    where id = v_id;
    return jsonb_build_object(''success'', true, ''profileId'', v_id);';
begin
    if position(a in v_def) = 0 then raise exception 'profile anchor not found'; end if;
    v_def := replace(v_def, a, '    where id = v_id;
    -- 2026-11-10 (owner): the official name, required, in Arabic for an Arab country''s payroll
    if p_profile ? ''legal_name'' then
        update payroll_profiles set legal_name = nullif(regexp_replace(trim(coalesce(p_profile ->> ''legal_name'', '''')), ''\s+'', '' '', ''g''), '''') where id = v_id;
    end if;
    if (select legal_name from payroll_profiles where id = v_id) is null then raise exception ''LEGAL NAME IS REQUIRED''; end if;
    if public.prosm_time_payroll_name_in_arabic(v_org)
       and ((select legal_name from payroll_profiles where id = v_id) ~ ''[A-Za-z]''
            or (select legal_name from payroll_profiles where id = v_id) !~ ''[؀-ۿ]'') then
        raise exception ''LEGAL NAME MUST BE IN ARABIC'';
    end if;
    return jsonb_build_object(''success'', true, ''profileId'', v_id);');
    execute v_def;
end;
$patch$;

-- a person added to a cycle carries their official name
create or replace function public.prosm_time_payroll_cycle_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.full_name := coalesce((select legal_name from payroll_profiles where user_id = new.user_id and legal_name is not null), new.full_name);
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_cycle_name() from public, anon, authenticated;
drop trigger if exists payroll_cycle_employees_name on public.payroll_cycle_employees;
create trigger payroll_cycle_employees_name
before insert on public.payroll_cycle_employees
for each row execute function public.prosm_time_payroll_cycle_name();

-- a changed name reaches the open cycles
create or replace function public.prosm_time_payroll_name_follows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.legal_name is null or new.legal_name is not distinct from old.legal_name then return new; end if;
    update payroll_cycle_employees ce set full_name = new.legal_name
    from payroll_cycles c
    where c.id = ce.cycle_id and ce.user_id = new.user_id and c.status in ('draft', 'reopened');
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_name_follows() from public, anon, authenticated;
drop trigger if exists payroll_profiles_name_follows on public.payroll_profiles;
create trigger payroll_profiles_name_follows
after update of legal_name on public.payroll_profiles
for each row execute function public.prosm_time_payroll_name_follows();

commit;
