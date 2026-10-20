-- Owner 2026-10-20 ("allowances stay with the employee: they add them daily,
-- or they are added automatically if the employee turns on auto-fill, and
-- the employee has the choice of sending them to the manager"; "the Owner
-- has no allowances of course").
-- 1. An employee can turn on auto-fill: when a shift is clocked out, that
--    day's allowances are created from the prices (a day already started is
--    left alone). Nothing is sent - the employee still sends to the manager.
-- 2. "Send to manager" sends every draft of a period at once.
-- 3. The Owner does not clock in, so has no allowances of their own.

begin;

create table public.allowance_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    auto_fill boolean not null default false,
    updated_at timestamptz not null default now()
);

alter table public.allowance_preferences enable row level security;
revoke all on public.allowance_preferences from anon, authenticated;
grant select on public.allowance_preferences to authenticated;

create policy "allowance preferences visible to the person"
on public.allowance_preferences for select to authenticated
using (user_id = public.current_prosm_time_user_id() and organization_id = public.current_prosm_time_organization_id());

create or replace function public.set_prosm_time_allowance_auto_fill(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if public.current_prosm_time_user_is_owner() then raise exception 'THE OWNER HAS NO ALLOWANCES'; end if;
    insert into allowance_preferences (user_id, organization_id, auto_fill)
    values (v_caller, public.current_prosm_time_organization_id(), coalesce(p_enabled, false))
    on conflict (user_id) do update set auto_fill = excluded.auto_fill, updated_at = now();
    return jsonb_build_object('success', true, 'autoFill', coalesce(p_enabled, false));
end;
$function$;

revoke all on function public.set_prosm_time_allowance_auto_fill(boolean) from public, anon;
grant execute on function public.set_prosm_time_allowance_auto_fill(boolean) to authenticated;

-- A day's allowances for a person, from the prices, if the day has none yet
-- (the same amounts upsert_prosm_time_allowance_entry starts a new day with).
create or replace function public.prosm_time_start_allowance_day(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_session_id uuid;
    v_site_id uuid;
    v_overtime_minutes double precision := 0;
    v_overtime_days numeric;
    v_rates jsonb;
begin
    select organization_id into v_org from users where id = p_user_id and not is_owner;
    if v_org is null or exists (select 1 from allowance_entries where user_id = p_user_id and entry_date = p_day) then
        return;
    end if;

    select ats.id, coalesce(ats.site_id, ats.responsible_site_id) into v_session_id, v_site_id
    from attendance_sessions ats
    where ats.user_id = p_user_id and ats.clock_in_at::date = p_day
    order by ats.clock_in_at desc
    limit 1;
    if v_session_id is null then return; end if;

    select coalesce(sum(
        case
            when s.overtime_start_time is not null and ats.clock_out_at is not null then
                greatest(extract(epoch from ((ats.clock_out_at at time zone s.timezone)::time - s.overtime_start_time)) / 60, 0)
            else 0
        end
    ), 0)
    into v_overtime_minutes
    from attendance_sessions ats
    left join sites s on s.id = ats.site_id
    where ats.user_id = p_user_id and ats.clock_in_at::date = p_day;
    v_overtime_days := case when v_overtime_minutes > 0 then 1 else 0 end;

    v_rates := public.prosm_time_resolve_allowance_rates(p_user_id, v_site_id);

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance,
        housing_allowance, travel_allowance, other_allowance,
        overtime_hours, overtime_days, overtime_amount, extra_days_amount, status
    ) values (
        v_org, p_user_id, v_session_id, p_day,
        coalesce((v_rates ->> 'meal')::numeric, 0), coalesce((v_rates ->> 'expatriation')::numeric, 0),
        coalesce((v_rates ->> 'transportation')::numeric, 0), coalesce((v_rates ->> 'housing')::numeric, 0),
        coalesce((v_rates ->> 'travel')::numeric, 0), coalesce((v_rates ->> 'other')::numeric, 0),
        round((v_overtime_minutes / 60)::numeric, 2), v_overtime_days,
        round((v_overtime_minutes / 60)::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0), 2),
        round(v_overtime_days * coalesce((v_rates ->> 'extraDay')::numeric, 0), 2),
        'draft'
    )
    on conflict (user_id, entry_date) do nothing;
end;
$function$;

revoke all on function public.prosm_time_start_allowance_day(uuid, date) from public, anon, authenticated;

-- Auto-fill: when a shift closes, its day is started for those who asked.
create or replace function public.prosm_time_auto_fill_allowance_on_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if new.status = 'clocked_out' and old.status is distinct from 'clocked_out'
       and exists (select 1 from allowance_preferences p where p.user_id = new.user_id and p.auto_fill) then
        begin
            perform public.prosm_time_start_allowance_day(new.user_id, new.clock_in_at::date);
        exception when others then
            -- never let allowances block a clock-out
            null;
        end;
    end if;
    return new;
end;
$function$;

revoke all on function public.prosm_time_auto_fill_allowance_on_clock_out() from public, anon, authenticated;

drop trigger if exists attendance_sessions_auto_fill_allowance on public.attendance_sessions;
create trigger attendance_sessions_auto_fill_allowance
after update of status on public.attendance_sessions
for each row execute function public.prosm_time_auto_fill_allowance_on_clock_out();

-- Send every draft (and rejected entry) of a period to the manager at once.
create or replace function public.submit_prosm_time_allowances(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_entry uuid;
    v_count integer := 0;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    for v_entry in
        select id from allowance_entries
        where user_id = v_caller and status in ('draft', 'rejected') and entry_date between p_from and p_to
        order by entry_date
    loop
        perform public.submit_prosm_time_allowance_entry(v_entry);
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'sent', v_count);
end;
$function$;

revoke all on function public.submit_prosm_time_allowances(date, date) from public, anon;
grant execute on function public.submit_prosm_time_allowances(date, date) to authenticated;

-- The Owner has no allowances of their own (every path that creates one goes through this table).
create or replace function public.prosm_time_refuse_owner_allowance()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if exists (select 1 from users where id = new.user_id and is_owner) then
        raise exception 'THE OWNER HAS NO ALLOWANCES';
    end if;
    return new;
end;
$function$;

revoke all on function public.prosm_time_refuse_owner_allowance() from public, anon, authenticated;

drop trigger if exists allowance_entries_not_for_the_owner on public.allowance_entries;
create trigger allowance_entries_not_for_the_owner
before insert on public.allowance_entries
for each row execute function public.prosm_time_refuse_owner_allowance();

commit;
