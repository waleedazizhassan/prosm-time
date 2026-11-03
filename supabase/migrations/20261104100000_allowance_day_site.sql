-- Owner 2026-11-03: "the site box in the allowance sheet doesn't fill" - and allowances
-- smarter, more accurate, easier (his own PROSM Allow app as the model).
--
-- 1. A day follows its attendance whenever the attendance changes: a shift recorded already
--    closed (on someone's behalf, a correction), a changed clock-in/out time or site - not
--    only a clock-out. Before, those days stayed without their shift: no site, no hours.
-- 2. A day with no attendance (travel, an errand, a day at a client's) can be given its own
--    site, and is priced at that site. The attendance's site, when there is one, wins.
-- 3. "Apply the current prices" to the open days of a period, like his app's button: every
--    allowance that has a price is set from it; what has no price (travel, typed by hand)
--    and what a reviewer changed are kept.
-- 4. The days already saved without their shift are linked now (approved days keep their
--    amounts; only the link is added, for the site and times to show).

alter table public.allowance_entries
    add column if not exists site_id uuid references public.sites(id) on delete set null;

create index if not exists allowance_entries_site_idx on public.allowance_entries (site_id) where site_id is not null;

-- The day's facts: the attendance's site, else the site chosen on the day.
create or replace function public.prosm_time_allowance_day_facts(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
    v_session_id uuid;
    v_summary jsonb;
    v_site uuid;
    v_rates jsonb;
    v_overtime numeric;
    v_weighted numeric;
    v_extra_days numeric := 0;
begin
    select ats.id into v_session_id
    from attendance_sessions ats
    where ats.user_id = p_user_id and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
    order by ats.clock_in_at desc limit 1;

    v_summary := public.prosm_time_day_summary(p_user_id, p_day);
    v_site := coalesce(
        (v_summary ->> 'siteId')::uuid,
        (select e.site_id from allowance_entries e where e.user_id = p_user_id and e.entry_date = p_day)
    );
    v_rates := public.prosm_time_resolve_allowance_rates(p_user_id, v_site);
    v_overtime := (v_summary ->> 'overtimeMinutes')::numeric;
    v_weighted := (v_summary ->> 'overtimeWeightedMinutes')::numeric;

    if v_summary ->> 'dayType' in ('weekly_rest', 'public_holiday') and (v_summary ->> 'workedMinutes')::numeric > 0
       and coalesce((v_rates ->> 'extraDay')::numeric, 0) > 0 then
        v_extra_days := 1;
        v_overtime := 0;
        v_weighted := 0;
    end if;

    return jsonb_build_object(
        'sessionId', v_session_id, 'siteId', v_site, 'workedMinutes', (v_summary ->> 'workedMinutes')::numeric,
        'overtimeMinutes', v_overtime, 'overtimeWeightedMinutes', v_weighted, 'extraDays', v_extra_days,
        'dayType', v_summary ->> 'dayType', 'rates', v_rates
    );
end;
$function$;

-- Refresh: an approved day keeps every amount, but gets its shift linked if it had none.
create or replace function public.prosm_time_refresh_allowance_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
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
    if v_entry.id is null then return; end if;

    v_facts := public.prosm_time_allowance_day_facts(v_entry.user_id, v_entry.entry_date);

    if v_entry.status = 'approved' then
        if v_entry.attendance_session_id is null and v_facts ->> 'sessionId' is not null then
            update allowance_entries set attendance_session_id = (v_facts ->> 'sessionId')::uuid where id = p_entry_id;
        end if;
        return;
    end if;

    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_entry.organization_id);

    update allowance_entries set
        attendance_session_id = coalesce((v_facts ->> 'sessionId')::uuid, attendance_session_id),
        worked_minutes = (v_facts ->> 'workedMinutes')::numeric,
        overtime_minutes = (v_facts ->> 'overtimeMinutes')::numeric,
        overtime_hours = (v_facts ->> 'overtimeMinutes')::numeric / 60,
        overtime_days = (v_facts ->> 'extraDays')::numeric,
        day_type = v_facts ->> 'dayType',
        overtime_amount = round((v_facts ->> 'overtimeWeightedMinutes')::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0) / 60, 2),
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

    for v_key in select jsonb_object_keys(v_entry.manual_overrides) loop
        v_column := public.prosm_time_allowance_line_column(v_key);
        if v_column is not null then
            execute format('update allowance_entries set %I = $1 where id = $2', v_column)
            using (v_entry.manual_overrides -> v_key ->> 'value')::numeric, p_entry_id;
        end if;
    end loop;
end;
$function$;

-- Prices a day from its rates: each allowance with a price > 0 is set from it; one with no
-- price keeps what was typed; one a reviewer changed keeps the reviewer's value.
create or replace function public.prosm_time_price_allowance_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_entry allowance_entries%rowtype;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_key text;
begin
    select * into v_entry from allowance_entries where id = p_entry_id for update;
    if v_entry.id is null or v_entry.status = 'approved' then return; end if;
    v_facts := public.prosm_time_allowance_day_facts(v_entry.user_id, v_entry.entry_date);
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_entry.organization_id);
    foreach v_key in array array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other'] loop
        if coalesce((v_rates ->> v_key)::numeric, 0) > 0 and not (coalesce(v_entry.manual_overrides, '{}'::jsonb) ? v_key) then
            execute format('update allowance_entries set %I = $1, updated_at = now() where id = $2', v_key || '_allowance')
            using round(public.prosm_time_allowance_amount(v_basis ->> v_key, (v_rates ->> v_key)::numeric, v_facts), 2), p_entry_id;
        end if;
    end loop;
    perform public.prosm_time_refresh_allowance_entry(p_entry_id);
end;
$function$;

revoke all on function public.prosm_time_price_allowance_entry(uuid) from public, anon, authenticated;

-- Save a day: the same as before, plus its own site (p_set_site: change it; null clears).
-- A new day, or a day whose site changed, is priced from its rates.
drop function if exists public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text);

create or replace function public.upsert_prosm_time_allowance_entry(
    p_entry_date date,
    p_meal_allowance numeric default 0,
    p_expatriation_allowance numeric default 0,
    p_transportation_allowance numeric default 0,
    p_housing_allowance numeric default 0,
    p_travel_allowance numeric default 0,
    p_other_allowance numeric default 0,
    p_other_allowance_note text default null,
    p_site_id uuid default null,
    p_set_site boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_status text;
    v_existing_site uuid;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_new boolean;
    v_site_changed boolean := false;
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
    if p_set_site and p_site_id is not null
       and not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_caller_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    select status, site_id into v_existing_status, v_existing_site from allowance_entries where user_id = v_caller_id and entry_date = p_entry_date;
    if v_existing_status = 'approved' then
        raise exception 'THIS ALLOWANCE ENTRY IS ALREADY APPROVED';
    end if;
    v_new := v_existing_status is null;
    v_site_changed := p_set_site and p_site_id is distinct from v_existing_site;

    if v_new then
        -- the site first, so a new day is priced at it
        insert into allowance_entries (organization_id, user_id, entry_date, site_id, status, updated_at)
        values (v_caller_org, v_caller_id, p_entry_date, case when p_set_site then p_site_id end, 'draft', now())
        on conflict (user_id, entry_date) do nothing;
    elsif v_site_changed then
        update allowance_entries set site_id = p_site_id where user_id = v_caller_id and entry_date = p_entry_date;
    end if;

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

    update allowance_entries set
        attendance_session_id = coalesce((v_facts ->> 'sessionId')::uuid, attendance_session_id),
        meal_allowance = v_meal,
        expatriation_allowance = v_expatriation,
        transportation_allowance = v_transportation,
        housing_allowance = v_housing,
        travel_allowance = v_travel,
        other_allowance = v_other,
        other_allowance_note = p_other_allowance_note,
        status = case when status = 'rejected' then 'draft' else status end,
        updated_at = now()
    where user_id = v_caller_id and entry_date = p_entry_date
    returning id into v_entry_id;

    if v_site_changed and not v_new then
        -- a day moved to another site takes that site's prices
        perform public.prosm_time_price_allowance_entry(v_entry_id);
    else
        -- the time-based parts are always the server's
        perform public.prosm_time_refresh_allowance_entry(v_entry_id);
    end if;

    return jsonb_build_object('success', true, 'entryId', v_entry_id);
exception
    when others then
        raise exception 'UPSERT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, boolean) to authenticated;

-- "Apply the current prices" to the caller's open days of a period.
create or replace function public.reprice_prosm_time_allowances(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_entry uuid;
    v_count integer := 0;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'CHOOSE A PERIOD OF UP TO TWO MONTHS'; end if;
    for v_entry in
        select id from allowance_entries
        where user_id = v_caller and entry_date between p_from and p_to and status <> 'approved'
        order by entry_date
    loop
        perform public.prosm_time_price_allowance_entry(v_entry);
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'priced', v_count);
end;
$function$;

revoke all on function public.reprice_prosm_time_allowances(date, date) from public, anon;
grant execute on function public.reprice_prosm_time_allowances(date, date) to authenticated;

-- The day follows its attendance on every change that matters, not only a clock-out.
create or replace function public.prosm_time_auto_fill_allowance_on_clock_out()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_day date;
    v_old_day date;
    v_entry uuid;
begin
    if new.status <> 'clocked_out' or coalesce(new.hours_review_status, 'none') = 'pending' then
        return new;
    end if;
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.hours_review_status is not distinct from new.hours_review_status
       and old.clock_in_at is not distinct from new.clock_in_at
       and old.clock_out_at is not distinct from new.clock_out_at
       and old.site_id is not distinct from new.site_id then
        return new;
    end if;
    begin
        v_day := public.prosm_time_work_date(new.clock_in_at, new.site_id, new.organization_id);
        select id into v_entry from allowance_entries where user_id = new.user_id and entry_date = v_day;
        if v_entry is not null then
            perform public.prosm_time_refresh_allowance_entry(v_entry);
        elsif exists (select 1 from allowance_preferences p where p.user_id = new.user_id and p.auto_fill) then
            perform public.prosm_time_start_allowance_day(new.user_id, v_day);
        end if;
        -- a shift moved to another day: the day it left is refreshed too
        if tg_op = 'UPDATE' then
            v_old_day := public.prosm_time_work_date(old.clock_in_at, old.site_id, old.organization_id);
            if v_old_day is distinct from v_day then
                select id into v_entry from allowance_entries where user_id = new.user_id and entry_date = v_old_day;
                if v_entry is not null then
                    update allowance_entries set attendance_session_id = null where id = v_entry and attendance_session_id = new.id and status <> 'approved';
                    perform public.prosm_time_refresh_allowance_entry(v_entry);
                end if;
            end if;
        end if;
    exception when others then
        -- never let allowances block attendance
        null;
    end;
    return new;
end;
$function$;

drop trigger if exists attendance_sessions_auto_fill_allowance on public.attendance_sessions;
create trigger attendance_sessions_auto_fill_allowance
    after insert or update of status, hours_review_status, clock_in_at, clock_out_at, site_id on public.attendance_sessions
    for each row execute function public.prosm_time_auto_fill_allowance_on_clock_out();

-- The days already saved without their shift.
do $backfill$
declare
    v_entry record;
begin
    for v_entry in
        select e.id from allowance_entries e
        where e.attendance_session_id is null
          and exists (select 1 from attendance_sessions a
                      where a.user_id = e.user_id
                        and public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) = e.entry_date)
    loop
        begin
            perform public.prosm_time_refresh_allowance_entry(v_entry.id);
        exception when others then
            -- a read-only organisation keeps the day as it is
            null;
        end;
    end loop;
end;
$backfill$;
