-- Owner 2026-11-04: the owner's "X will work overtime" alert comes by default a quarter of an
-- hour AFTER the shift ends (not half an hour before it), and the owner sets the minutes.
-- overtime_alert_minutes: minutes after the shift's end (negative = before it).

alter table public.organization_settings
    add column if not exists overtime_alert_minutes integer not null default 15;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'organization_settings_overtime_alert_minutes_check') then
        alter table public.organization_settings
            add constraint organization_settings_overtime_alert_minutes_check check (overtime_alert_minutes between -120 and 240);
    end if;
end $$;

create or replace function public.get_prosm_time_overtime_alert_minutes()
returns integer
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select s.overtime_alert_minutes from organization_settings s
                     where s.organization_id = public.current_prosm_time_organization_id()), 15);
$$;
revoke all on function public.get_prosm_time_overtime_alert_minutes() from public, anon;
grant execute on function public.get_prosm_time_overtime_alert_minutes() to authenticated;

create or replace function public.set_prosm_time_overtime_alert_minutes(p_minutes integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from users where id = public.current_prosm_time_user_id() and is_owner) then
        raise exception 'ONLY THE OWNER SETS THE OVERTIME POLICY';
    end if;
    if p_minutes is null or p_minutes < -120 or p_minutes > 240 then
        raise exception 'CHECK THE VALUES';
    end if;
    insert into organization_settings (organization_id, overtime_alert_minutes) values (v_org, p_minutes)
    on conflict (organization_id) do update set overtime_alert_minutes = excluded.overtime_alert_minutes;
end;
$$;
revoke all on function public.set_prosm_time_overtime_alert_minutes(integer) from public, anon;
grant execute on function public.set_prosm_time_overtime_alert_minutes(integer) to authenticated;

-- The alert loop: the window is the shift's end + the organisation's minutes, for half an hour.
do $patch$
declare
    v_def text;
    v_old text := 'continue when not (now() >= v_end - interval ''30 minutes'' and now() < v_end);';
    v_new text := 'continue when not (now() >= v_end + make_interval(mins => coalesce((select os.overtime_alert_minutes from organization_settings os where os.organization_id = v_row.organization_id), 15))'
               || ' and now() < v_end + make_interval(mins => coalesce((select os.overtime_alert_minutes from organization_settings os where os.organization_id = v_row.organization_id), 15)) + interval ''30 minutes'');';
begin
    select pg_get_functiondef('public.process_prosm_time_manager_alerts()'::regprocedure) into v_def;
    if position(v_old in v_def) = 0 then
        raise exception 'overtime alert window not found';
    end if;
    v_def := replace(v_def, v_old, v_new);
    v_def := replace(v_def, '''Overtime soon''', '''Working overtime''');
    v_def := replace(v_def, ''' is still clocked in; overtime starts at ''', ''' is still clocked in; the shift ended at ''');
    execute v_def;
end;
$patch$;
