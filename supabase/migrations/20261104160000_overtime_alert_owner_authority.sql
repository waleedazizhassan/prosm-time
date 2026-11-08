-- The overtime-alert minutes follow the owner's authority (the owner, or a person holding it).
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
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE OWNER SETS THE OVERTIME POLICY';
    end if;
    if p_minutes is null or p_minutes < -120 or p_minutes > 240 then
        raise exception 'CHECK THE VALUES';
    end if;
    insert into organization_settings (organization_id, overtime_alert_minutes) values (v_org, p_minutes)
    on conflict (organization_id) do update set overtime_alert_minutes = excluded.overtime_alert_minutes;
end;
$$;
