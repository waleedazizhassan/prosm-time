-- 2026-11-10 (owner): "in some companies lateness and overtime go to the salary, in others to the
-- allowances - a choice between the two, and a third: not counted at all. By plan: with payroll the
-- choice is salary / allowances / not counted; with allowances only: counted (on the allowances) or not;
-- with neither, no choice."
--   organization_settings.overtime_late_target: 'payroll' | 'allowances' | 'none' (null = the default:
--   allowances when the plan has them - as until now - else payroll, else none).
--   * 'payroll': the payroll cycle suggests the period's lateness and overtime; the allowance sheets do
--     not price overtime (nor extra days).
--   * 'allowances': the allowance sheets price overtime (and extra days) as before; payroll does not
--     suggest lateness or overtime.
--   * 'none': neither - the timesheets still show the hours.
--   Approved allowance days and approved payroll cycles never change.
-- Rollback: restore list_prosm_time_payroll_suggestions and prosm_time_allowance_day_facts from their
-- previous migrations; drop the two functions and the column.

begin;

alter table public.organization_settings add column if not exists overtime_late_target text
    check (overtime_late_target in ('payroll', 'allowances', 'none'));

create or replace function public.prosm_time_overtime_late_target(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select case
        when t = 'payroll' and public.prosm_time_plan_allows(p_org, 'payroll') then 'payroll'
        when t = 'allowances' and public.prosm_time_plan_allows(p_org, 'allowances') then 'allowances'
        when t = 'none' then 'none'
        when public.prosm_time_plan_allows(p_org, 'allowances') then 'allowances'
        when public.prosm_time_plan_allows(p_org, 'payroll') then 'payroll'
        else 'none'
    end
    from (select (select overtime_late_target from organization_settings where organization_id = p_org) as t) x;
$$;
revoke all on function public.prosm_time_overtime_late_target(uuid) from public, anon, authenticated;

create or replace function public.get_prosm_time_overtime_late_target()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_overtime_late_target(public.current_prosm_time_organization_id());
$$;
revoke all on function public.get_prosm_time_overtime_late_target() from public, anon;
grant execute on function public.get_prosm_time_overtime_late_target() to authenticated;

create or replace function public.set_prosm_time_overtime_late_target(p_target text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY CHANGE THIS'; end if;
    if p_target not in ('payroll', 'allowances', 'none') then raise exception 'INVALID CHOICE'; end if;
    if p_target = 'payroll' and not public.prosm_time_plan_allows(v_org, 'payroll') then raise exception 'FEATURE NOT IN PLAN: payroll'; end if;
    if p_target = 'allowances' and not public.prosm_time_plan_allows(v_org, 'allowances') then raise exception 'FEATURE NOT IN PLAN: allowances'; end if;
    update organization_settings set overtime_late_target = p_target where organization_id = v_org;
    return jsonb_build_object('success', true, 'target', p_target);
end;
$$;
revoke all on function public.set_prosm_time_overtime_late_target(text) from public, anon;
grant execute on function public.set_prosm_time_overtime_late_target(text) to authenticated;

do $patch$
declare
    v_def text;
    a text;
begin
    -- payroll suggests lateness and overtime only when they go to the salary
    v_def := pg_get_functiondef('public.list_prosm_time_payroll_suggestions(uuid)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    a := '                having coalesce(sum(ts.total_deduction_minutes), 0) > 0';
    if position(a in v_def) = 0 then raise exception 'late suggestion anchor not found'; end if;
    v_def := replace(v_def, a, '                  and public.prosm_time_overtime_late_target(v_cycle.organization_id) = ''payroll''
' || a);
    a := '                having coalesce(sum(ts.total_overtime_minutes), 0) > 0';
    if position(a in v_def) = 0 then raise exception 'overtime suggestion anchor not found'; end if;
    v_def := replace(v_def, a, '                  and public.prosm_time_overtime_late_target(v_cycle.organization_id) = ''payroll''
' || a);
    execute v_def;

    -- the allowance sheets price overtime (and extra days) only when they go to the allowances
    v_def := pg_get_functiondef('public.prosm_time_allowance_day_facts(uuid,date)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    a := '    return jsonb_build_object(
        ''sessionId'', v_session_id,';
    if position(a in v_def) = 0 then raise exception 'allowance facts anchor not found'; end if;
    v_def := replace(v_def, a, '    -- 2026-11-10: overtime goes to the allowances only when the organisation chose so
    if public.prosm_time_overtime_late_target((select organization_id from users where id = p_user_id)) <> ''allowances'' then
        v_overtime := 0;
        v_weighted := 0;
        v_extra_days := 0;
    end if;
' || a);
    execute v_def;
end;
$patch$;

commit;
