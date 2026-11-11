-- 2026-11-11 (owner): "the allowance sheet like the real one" - when lateness and overtime are counted
-- on the allowances, the sheets also take off lateness: a price per late minute (set like the other
-- prices - by site, category or person), and each day's late minutes (as counted for deductions, after
-- any permission) times that price come off the day's total. Approved days never change.
-- Rollback: restore the five patched functions from their previous migrations; drop the columns
-- allowance_rates.late_minute, allowance_entries.late_minutes and late_amount.

begin;

alter table public.allowance_rates add column if not exists late_minute numeric(12,4);
alter table public.allowance_entries
    add column if not exists late_minutes numeric(10,2) not null default 0,
    add column if not exists late_amount numeric(12,2) not null default 0;

do $patch$
declare
    v_def text;
    a text;
begin
    -- the price resolves like the others
    v_def := replace(pg_get_functiondef('public.prosm_time_resolve_allowance_rates(uuid,uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    a := '''extraDay'', (select extra_day from scopes where extra_day is not null order by rank desc limit 1)';
    if position(a in v_def) = 0 then raise exception 'resolve anchor not found'; end if;
    v_def := replace(v_def, a, a || ',
        ''lateMinute'', (select late_minute from scopes where late_minute is not null order by rank desc limit 1)');
    execute v_def;

    -- and is saved like the others
    v_def := replace(pg_get_functiondef('public.set_prosm_time_allowance_rates(uuid,uuid,uuid,jsonb)'::regprocedure), chr(13) || chr(10), chr(10));
    a := '''overtimeHour'', ''extraDay''] loop';
    if position(a in v_def) = 0 then raise exception 'rates list anchor not found'; end if;
    v_def := replace(v_def, a, '''overtimeHour'', ''extraDay'', ''lateMinute''] loop');
    a := '        extra_day = (p_rates ->> ''extraDay'')::numeric,';
    if position(a in v_def) = 0 then raise exception 'rates update anchor not found'; end if;
    v_def := replace(v_def, a, a || '
        late_minute = (p_rates ->> ''lateMinute'')::numeric,');
    a := 'and overtime_hour is null and extra_day is null;';
    if position(a in v_def) = 0 then raise exception 'rates delete anchor not found'; end if;
    v_def := replace(v_def, a, 'and overtime_hour is null and extra_day is null and late_minute is null;');
    execute v_def;

    -- the day's late minutes, when lateness is counted on the allowances
    v_def := replace(pg_get_functiondef('public.prosm_time_allowance_day_facts(uuid,date)'::regprocedure), chr(13) || chr(10), chr(10));
    a := '''extraDays'', v_extra_days,';
    if position(a in v_def) = 0 then raise exception 'facts anchor not found'; end if;
    v_def := replace(v_def, a, a || '
        ''lateMinutes'', case when public.prosm_time_overtime_late_target((select organization_id from users where id = p_user_id)) = ''allowances''
                              then coalesce((v_summary ->> ''deductionMinutes'')::numeric, 0) else 0 end,');
    execute v_def;

    -- the day carries them and their price
    v_def := replace(pg_get_functiondef('public.prosm_time_refresh_allowance_entry(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    a := '        extra_days_amount = round((v_facts ->> ''extraDays'')::numeric * coalesce((v_rates ->> ''extraDay'')::numeric, 0), 2),';
    if position(a in v_def) = 0 then raise exception 'refresh anchor not found'; end if;
    v_def := replace(v_def, a, a || '
        late_minutes = coalesce((v_facts ->> ''lateMinutes'')::numeric, 0),
        late_amount = round(coalesce((v_facts ->> ''lateMinutes'')::numeric, 0) * coalesce((v_rates ->> ''lateMinute'')::numeric, 0), 2),');
    execute v_def;

    -- and the day's total takes it off
    v_def := replace(pg_get_functiondef('public.prosm_time_entry_total(allowance_entries)'::regprocedure), chr(13) || chr(10), chr(10));
    a := '+ e.overtime_amount + e.extra_days_amount';
    if position(a in v_def) = 0 then raise exception 'total anchor not found'; end if;
    v_def := replace(v_def, a, a || ' - coalesce(e.late_amount, 0)');
    execute v_def;
end;
$patch$;

commit;
