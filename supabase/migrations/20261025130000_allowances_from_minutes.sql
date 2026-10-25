-- PROSM Time v2.3.43, step 4 (item 6): allowances tied to time are paid for
-- the time actually worked - an hour at 100 and a quarter of an hour worked
-- is 25, never a whole hour.
--   * overtime is kept in MINUTES (allowance_entries.overtime_minutes) and
--     its amount is rate x minutes / 60, rounded to 2 decimals only at the end;
--     overtime_hours becomes an exact numeric (it was numeric(6,2): 7 minutes
--     were stored as 0.12 h);
--   * each allowance type has a calculation basis for the organisation
--     (allowance_basis): fixed_per_day (meal, expatriation, transport,
--     housing, travel, other - the default), per_hour (rate x minutes worked
--     that day / 60) or per_extra_day (rate x extra days);
--   * an extra day is a day worked on a weekly rest day or a public holiday
--     (the work calendar, step 3) - it used to be "any day with overtime";
--     on such a day the hours are priced as an extra day when the person has
--     an extra-day price, otherwise every minute is overtime;
--   * pending hours (an automatically closed shift, step 2) count for nothing;
--   * days are the site's work date (Cairo time), not the UTC date;
--   * entries not yet approved are recalculated now; approved entries are
--     never touched.

begin;

alter table public.allowance_entries alter column overtime_hours type numeric;
alter table public.allowance_entries add column if not exists overtime_minutes numeric not null default 0;
alter table public.allowance_entries add column if not exists worked_minutes numeric not null default 0;
alter table public.allowance_entries add column if not exists day_type text not null default 'workday';
alter table public.allowance_entries drop constraint if exists allowance_entries_day_type_check;
alter table public.allowance_entries add constraint allowance_entries_day_type_check check (day_type in ('workday', 'weekly_rest', 'public_holiday'));

create table if not exists public.allowance_basis (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    allowance_key text not null check (allowance_key in ('meal', 'expatriation', 'transportation', 'housing', 'travel', 'other')),
    basis text not null check (basis in ('fixed_per_day', 'per_hour', 'per_extra_day')),
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (organization_id, allowance_key)
);

alter table public.allowance_basis enable row level security;
revoke all on public.allowance_basis from anon, authenticated;
grant select on public.allowance_basis to authenticated;
drop policy if exists "allowance basis visible to the organisation" on public.allowance_basis;
create policy "allowance basis visible to the organisation" on public.allowance_basis
for select to authenticated using (organization_id = public.current_prosm_time_organization_id());

-- The basis of every allowance for an organisation (missing = fixed_per_day).
create or replace function public.prosm_time_allowance_basis(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    select jsonb_object_agg(k.key, coalesce(b.basis, 'fixed_per_day'))
    from unnest(array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other']) as k(key)
    left join allowance_basis b on b.organization_id = p_organization_id and b.allowance_key = k.key;
$function$;

revoke all on function public.prosm_time_allowance_basis(uuid) from public, anon;
grant execute on function public.prosm_time_allowance_basis(uuid) to authenticated;

create or replace function public.set_prosm_time_allowance_basis(p_allowance_key text, p_basis text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_before text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER SETS HOW AN ALLOWANCE IS CALCULATED'; end if;
    if p_allowance_key not in ('meal', 'expatriation', 'transportation', 'housing', 'travel', 'other') then raise exception 'INVALID ALLOWANCE'; end if;
    if p_basis not in ('fixed_per_day', 'per_hour', 'per_extra_day') then raise exception 'INVALID CALCULATION BASIS'; end if;
    select basis into v_before from allowance_basis where organization_id = v_org and allowance_key = p_allowance_key;
    insert into allowance_basis (organization_id, allowance_key, basis, updated_by)
    values (v_org, p_allowance_key, p_basis, v_caller)
    on conflict (organization_id, allowance_key) do update set basis = excluded.basis, updated_by = excluded.updated_by, updated_at = now();
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, previous_state, new_state)
    values (v_org, v_caller, 'allowances.basis_set', 'allowance_basis', 'Allowance calculation basis changed',
            jsonb_build_object('allowance', p_allowance_key, 'basis', coalesce(v_before, 'fixed_per_day')),
            jsonb_build_object('allowance', p_allowance_key, 'basis', p_basis));
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.set_prosm_time_allowance_basis(text, text) from public, anon;
grant execute on function public.set_prosm_time_allowance_basis(text, text) to authenticated;

-- ------------------------------------------------------------------
-- The facts of a person's work day: minutes worked, overtime minutes,
-- extra days, the day's type, the site and its prices. Only shifts that
-- count (closed, not pending review). Minutes are exact.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_allowance_day_facts(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_session_id uuid;
    v_site_id uuid;
    v_worked numeric := 0;
    v_overtime numeric := 0;
    v_day_type text;
    v_exception jsonb;
    v_rates jsonb;
    v_extra_days numeric := 0;
begin
    select organization_id into v_org from users where id = p_user_id;

    select ats.id, coalesce(ats.site_id, ats.responsible_site_id) into v_session_id, v_site_id
    from attendance_sessions ats
    where ats.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
    order by ats.clock_in_at desc
    limit 1;

    if v_session_id is null then
        return jsonb_build_object('sessionId', null, 'siteId', null, 'workedMinutes', 0, 'overtimeMinutes', 0, 'extraDays', 0, 'dayType', 'workday',
                                  'rates', public.prosm_time_resolve_allowance_rates(p_user_id, null));
    end if;

    v_day_type := public.prosm_time_day_type(p_user_id, v_site_id, p_day);
    v_exception := public.prosm_time_day_exception(p_user_id, v_site_id, p_day);
    v_rates := public.prosm_time_resolve_allowance_rates(p_user_id, v_site_id);

    select coalesce(sum(extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60), 0),
           -- Overtime starts at the site's overtime time (or the exceptional
           -- day's end) on the work date, in the site's time zone; a shift that
           -- ends after midnight keeps counting (the time of day alone did not).
           coalesce(sum(
               case
                   when coalesce((v_exception ->> 'end_time')::time, s.overtime_start_time) is not null then
                       greatest(extract(epoch from (
                           ats.clock_out_at - greatest(
                               ats.clock_in_at,
                               (p_day + coalesce((v_exception ->> 'end_time')::time, s.overtime_start_time)) at time zone public.prosm_time_site_timezone(ats.site_id, ats.organization_id)
                           )
                       )) / 60, 0)
                   else 0
               end
           ), 0)
    into v_worked, v_overtime
    from attendance_sessions ats
    left join sites s on s.id = ats.site_id
    where ats.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);

    -- A rest day or a holiday worked: an extra day when there is an
    -- extra-day price, otherwise all of it is overtime.
    if v_day_type in ('weekly_rest', 'public_holiday') and v_worked > 0 then
        if coalesce((v_rates ->> 'extraDay')::numeric, 0) > 0 then
            v_extra_days := 1;
            v_overtime := 0;
        else
            v_overtime := v_worked;
        end if;
    end if;

    return jsonb_build_object(
        'sessionId', v_session_id, 'siteId', v_site_id, 'workedMinutes', v_worked, 'overtimeMinutes', v_overtime,
        'extraDays', v_extra_days, 'dayType', v_day_type, 'rates', v_rates
    );
end;
$function$;

revoke all on function public.prosm_time_allowance_day_facts(uuid, date) from public, anon, authenticated;

-- The amount of one allowance on a day from its basis (no early rounding).
create or replace function public.prosm_time_allowance_amount(p_basis text, p_rate numeric, p_facts jsonb)
returns numeric
language sql
immutable
set search_path = public
as $function$
    select case coalesce(p_basis, 'fixed_per_day')
        when 'per_hour' then coalesce(p_rate, 0) * coalesce((p_facts ->> 'workedMinutes')::numeric, 0) / 60
        when 'per_extra_day' then coalesce(p_rate, 0) * coalesce((p_facts ->> 'extraDays')::numeric, 0)
        else coalesce(p_rate, 0)
    end;
$function$;

-- Recompute the time-based parts of a day that is not approved: overtime
-- (minutes, hours, amount), extra days and their amount, and any allowance
-- priced per hour or per extra day. Fixed daily allowances stay as entered.
create or replace function public.prosm_time_refresh_allowance_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_entry allowance_entries%rowtype;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_key text;
    v_column text;
    v_value numeric;
begin
    select * into v_entry from allowance_entries where id = p_entry_id for update;
    if v_entry.id is null or v_entry.status = 'approved' then return; end if;

    v_facts := public.prosm_time_allowance_day_facts(v_entry.user_id, v_entry.entry_date);
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_entry.organization_id);

    update allowance_entries set
        attendance_session_id = coalesce((v_facts ->> 'sessionId')::uuid, attendance_session_id),
        worked_minutes = (v_facts ->> 'workedMinutes')::numeric,
        overtime_minutes = (v_facts ->> 'overtimeMinutes')::numeric,
        overtime_hours = (v_facts ->> 'overtimeMinutes')::numeric / 60,
        overtime_days = (v_facts ->> 'extraDays')::numeric,
        day_type = v_facts ->> 'dayType',
        overtime_amount = round((v_facts ->> 'overtimeMinutes')::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0) / 60, 2),
        extra_days_amount = round((v_facts ->> 'extraDays')::numeric * coalesce((v_rates ->> 'extraDay')::numeric, 0), 2),
        updated_at = now()
    where id = p_entry_id;

    foreach v_key in array array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other'] loop
        if v_basis ->> v_key in ('per_hour', 'per_extra_day') then
            v_column := v_key || '_allowance';
            v_value := round(public.prosm_time_allowance_amount(v_basis ->> v_key, (v_rates ->> v_key)::numeric, v_facts), 2);
            execute format('update allowance_entries set %I = $1 where id = $2', v_column) using v_value, p_entry_id;
        end if;
    end loop;
end;
$function$;

revoke all on function public.prosm_time_refresh_allowance_entry(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- A new day starts from the prices (per its basis); every save refreshes
-- the time-based parts.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_start_allowance_day(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_entry uuid;
begin
    select organization_id into v_org from users where id = p_user_id and not is_owner;
    if v_org is null or exists (select 1 from allowance_entries where user_id = p_user_id and entry_date = p_day) then
        return;
    end if;
    v_facts := public.prosm_time_allowance_day_facts(p_user_id, p_day);
    if v_facts ->> 'sessionId' is null or (v_facts ->> 'workedMinutes')::numeric <= 0 then return; end if;
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_org);

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance, housing_allowance, travel_allowance, other_allowance,
        status
    ) values (
        v_org, p_user_id, (v_facts ->> 'sessionId')::uuid, p_day,
        round(public.prosm_time_allowance_amount(v_basis ->> 'meal', (v_rates ->> 'meal')::numeric, v_facts), 2),
        round(public.prosm_time_allowance_amount(v_basis ->> 'expatriation', (v_rates ->> 'expatriation')::numeric, v_facts), 2),
        round(public.prosm_time_allowance_amount(v_basis ->> 'transportation', (v_rates ->> 'transportation')::numeric, v_facts), 2),
        round(public.prosm_time_allowance_amount(v_basis ->> 'housing', (v_rates ->> 'housing')::numeric, v_facts), 2),
        round(public.prosm_time_allowance_amount(v_basis ->> 'travel', (v_rates ->> 'travel')::numeric, v_facts), 2),
        round(public.prosm_time_allowance_amount(v_basis ->> 'other', (v_rates ->> 'other')::numeric, v_facts), 2),
        'draft'
    )
    on conflict (user_id, entry_date) do nothing
    returning id into v_entry;

    if v_entry is not null then
        perform public.prosm_time_refresh_allowance_entry(v_entry);
    end if;
end;
$function$;

revoke all on function public.prosm_time_start_allowance_day(uuid, date) from public, anon, authenticated;

create or replace function public.upsert_prosm_time_allowance_entry(
    p_entry_date date,
    p_meal_allowance numeric default 0,
    p_expatriation_allowance numeric default 0,
    p_transportation_allowance numeric default 0,
    p_housing_allowance numeric default 0,
    p_travel_allowance numeric default 0,
    p_other_allowance numeric default 0,
    p_other_allowance_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_status text;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_new boolean;
    v_entry_id uuid;
    v_meal numeric := coalesce(p_meal_allowance, 0);
    v_expatriation numeric := coalesce(p_expatriation_allowance, 0);
    v_transportation numeric := coalesce(p_transportation_allowance, 0);
    v_housing numeric := coalesce(p_housing_allowance, 0);
    v_travel numeric := coalesce(p_travel_allowance, 0);
    v_other numeric := coalesce(p_other_allowance, 0);
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_entry_date is null then
        raise exception 'ENTRY DATE IS REQUIRED';
    end if;

    if v_meal < 0 or v_expatriation < 0 or v_transportation < 0 or v_housing < 0 or v_travel < 0 or v_other < 0 then
        raise exception 'AN ALLOWANCE CANNOT BE NEGATIVE';
    end if;

    select status into v_existing_status from allowance_entries where user_id = v_caller_id and entry_date = p_entry_date;
    if v_existing_status = 'approved' then
        raise exception 'THIS ALLOWANCE ENTRY IS ALREADY APPROVED';
    end if;
    v_new := v_existing_status is null;

    v_facts := public.prosm_time_allowance_day_facts(v_caller_id, p_entry_date);
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_caller_org);

    -- A new day starts from the prices (what has no price stays for the employee to type).
    if v_new then
        if v_meal = 0 then v_meal := round(public.prosm_time_allowance_amount(v_basis ->> 'meal', (v_rates ->> 'meal')::numeric, v_facts), 2); end if;
        if v_expatriation = 0 then v_expatriation := round(public.prosm_time_allowance_amount(v_basis ->> 'expatriation', (v_rates ->> 'expatriation')::numeric, v_facts), 2); end if;
        if v_transportation = 0 then v_transportation := round(public.prosm_time_allowance_amount(v_basis ->> 'transportation', (v_rates ->> 'transportation')::numeric, v_facts), 2); end if;
        if v_housing = 0 then v_housing := round(public.prosm_time_allowance_amount(v_basis ->> 'housing', (v_rates ->> 'housing')::numeric, v_facts), 2); end if;
        if v_travel = 0 then v_travel := round(public.prosm_time_allowance_amount(v_basis ->> 'travel', (v_rates ->> 'travel')::numeric, v_facts), 2); end if;
        if v_other = 0 then v_other := round(public.prosm_time_allowance_amount(v_basis ->> 'other', (v_rates ->> 'other')::numeric, v_facts), 2); end if;
    end if;

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance,
        housing_allowance, travel_allowance, other_allowance, other_allowance_note,
        status, updated_at
    ) values (
        v_caller_org, v_caller_id, (v_facts ->> 'sessionId')::uuid, p_entry_date,
        v_meal, v_expatriation, v_transportation, v_housing, v_travel, v_other, p_other_allowance_note,
        'draft', now()
    )
    on conflict (user_id, entry_date) do update set
        meal_allowance = excluded.meal_allowance,
        expatriation_allowance = excluded.expatriation_allowance,
        transportation_allowance = excluded.transportation_allowance,
        housing_allowance = excluded.housing_allowance,
        travel_allowance = excluded.travel_allowance,
        other_allowance = excluded.other_allowance,
        other_allowance_note = excluded.other_allowance_note,
        status = case when allowance_entries.status = 'rejected' then 'draft' else allowance_entries.status end,
        updated_at = now()
    returning id into v_entry_id;

    -- The time-based parts are always the server's (allowances priced per
    -- hour or per extra day included - what the employee typed there is replaced).
    perform public.prosm_time_refresh_allowance_entry(v_entry_id);

    return jsonb_build_object('success', true, 'entryId', v_entry_id);
exception
    when others then
        raise exception 'UPSERT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.fill_prosm_time_allowances(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_day date;
    v_count integer := 0;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'CHOOSE A PERIOD OF UP TO TWO MONTHS'; end if;
    for v_day in
        select distinct public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id)
        from attendance_sessions ats
        where ats.user_id = v_caller
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_from and p_to
          and not exists (select 1 from allowance_entries e where e.user_id = v_caller
                          and e.entry_date = public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id))
        order by 1
    loop
        perform public.upsert_prosm_time_allowance_entry(v_day);
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'filled', v_count);
end;
$function$;

-- Auto-fill on clock-out (and when pending hours are reviewed): start the
-- day, or refresh an existing one that is not approved.
create or replace function public.prosm_time_auto_fill_allowance_on_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_day date;
    v_entry uuid;
begin
    if (new.status = 'clocked_out' and old.status is distinct from 'clocked_out' and new.hours_review_status <> 'pending')
       or (old.hours_review_status = 'pending' and new.hours_review_status = 'reviewed') then
        begin
            v_day := public.prosm_time_work_date(new.clock_in_at, new.site_id, new.organization_id);
            select id into v_entry from allowance_entries where user_id = new.user_id and entry_date = v_day;
            if v_entry is not null then
                perform public.prosm_time_refresh_allowance_entry(v_entry);
            elsif exists (select 1 from allowance_preferences p where p.user_id = new.user_id and p.auto_fill) then
                perform public.prosm_time_start_allowance_day(new.user_id, v_day);
            end if;
        exception when others then
            -- never let allowances block a clock-out
            null;
        end;
    end if;
    return new;
end;
$function$;

-- Recalculate every entry not yet approved (approved ones are never touched).
do $$
declare
    v_id uuid;
begin
    for v_id in select id from public.allowance_entries where status <> 'approved' loop
        perform public.prosm_time_refresh_allowance_entry(v_id);
    end loop;
end $$;

commit;
