-- Owner 2026-10-20 ("make allowances in PROSM Time work like my PROSM Allow
-- app, only easier"). In PROSM Allow the administrator prices each
-- allowance per site, per category of staff (engineers, technicians,
-- workers...) and per person, and the employee's daily sheet fills itself
-- from those prices; an allowance priced at zero (travel, usually) is typed
-- by hand. The order of precedence is: the site's price, then the
-- category's (for that site, or for every site), then the person's own (for
-- that site, or for every site), then the day itself.
--
-- PROSM Time already knows where each day was worked (the attendance), so
-- no file goes back and forth: a new allowance day is filled from the
-- prices of the site worked that day, the overtime hours and extra days
-- are priced too, and the employee only adds what has no price and
-- submits. Nothing about approval changes.

begin;

create table public.allowance_categories (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 80),
    created_at timestamptz not null default now(),
    unique (organization_id, name)
);

create table public.allowance_category_members (
    user_id uuid primary key references public.users(id) on delete cascade,
    category_id uuid not null references public.allowance_categories(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade
);

-- One row per scope: a site; a category (for one site or for every site);
-- a person (for one site or for every site). A blank price inherits.
create table public.allowance_rates (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    category_id uuid references public.allowance_categories(id) on delete cascade,
    user_id uuid references public.users(id) on delete cascade,
    meal numeric(12, 2) check (meal >= 0),
    expatriation numeric(12, 2) check (expatriation >= 0),
    transportation numeric(12, 2) check (transportation >= 0),
    housing numeric(12, 2) check (housing >= 0),
    travel numeric(12, 2) check (travel >= 0),
    other numeric(12, 2) check (other >= 0),
    overtime_hour numeric(12, 2) check (overtime_hour >= 0),
    extra_day numeric(12, 2) check (extra_day >= 0),
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    check (category_id is null or user_id is null),
    check (site_id is not null or category_id is not null or user_id is not null)
);

create unique index allowance_rates_scope_idx on public.allowance_rates (
    organization_id,
    coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

alter table public.allowance_entries add column if not exists overtime_amount numeric(12, 2) not null default 0;
alter table public.allowance_entries add column if not exists extra_days_amount numeric(12, 2) not null default 0;

alter table public.allowance_categories enable row level security;
alter table public.allowance_category_members enable row level security;
alter table public.allowance_rates enable row level security;
revoke all on public.allowance_categories, public.allowance_category_members, public.allowance_rates from anon, authenticated;
grant select on public.allowance_categories, public.allowance_category_members, public.allowance_rates to authenticated;

-- Prices are visible to the Owner and to those who review allowances; an
-- employee sees the prices that apply to them through
-- get_prosm_time_my_allowance_rates.
create policy "allowance categories visible to the organisation"
on public.allowance_categories for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

create policy "allowance category members visible to reviewers or the person"
on public.allowance_category_members for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or 'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
    )
);

create policy "allowance rates visible to reviewers"
on public.allowance_rates for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or 'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
    )
);

-- ============================================================
-- The price of each allowance for a person on a day at a site.
-- ============================================================

create or replace function public.prosm_time_resolve_allowance_rates(p_user_id uuid, p_site_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    with scopes as (
        -- the later in this list, the stronger
        select 1 as rank, r.* from allowance_rates r
        where r.site_id = p_site_id and r.category_id is null and r.user_id is null
        union all
        select 2, r.* from allowance_rates r
        join allowance_category_members m on m.category_id = r.category_id and m.user_id = p_user_id
        where r.site_id is null
        union all
        select 3, r.* from allowance_rates r
        join allowance_category_members m on m.category_id = r.category_id and m.user_id = p_user_id
        where r.site_id = p_site_id
        union all
        select 4, r.* from allowance_rates r where r.user_id = p_user_id and r.site_id is null
        union all
        select 5, r.* from allowance_rates r where r.user_id = p_user_id and r.site_id = p_site_id
    )
    select jsonb_build_object(
        'meal', (select meal from scopes where meal is not null order by rank desc limit 1),
        'expatriation', (select expatriation from scopes where expatriation is not null order by rank desc limit 1),
        'transportation', (select transportation from scopes where transportation is not null order by rank desc limit 1),
        'housing', (select housing from scopes where housing is not null order by rank desc limit 1),
        'travel', (select travel from scopes where travel is not null order by rank desc limit 1),
        'other', (select other from scopes where other is not null order by rank desc limit 1),
        'overtimeHour', (select overtime_hour from scopes where overtime_hour is not null order by rank desc limit 1),
        'extraDay', (select extra_day from scopes where extra_day is not null order by rank desc limit 1)
    );
$function$;

revoke all on function public.prosm_time_resolve_allowance_rates(uuid, uuid) from public, anon, authenticated;

-- An employee's own prices, for each of their sites.
create or replace function public.get_prosm_time_my_allowance_rates()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('siteId', s.id, 'siteName', s.name, 'rates', public.prosm_time_resolve_allowance_rates(v_caller, s.id)) order by s.name)
        from sites s join site_assignments sa on sa.site_id = s.id and sa.user_id = v_caller
    ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_prosm_time_my_allowance_rates() from public, anon;
grant execute on function public.get_prosm_time_my_allowance_rates() to authenticated;

-- ============================================================
-- Setting prices. The Owner sets anything. A manager who reviews
-- allowances sets the prices of the sites they manage, of a category at
-- those sites, and of the people below them there.
-- ============================================================

create or replace function public.set_prosm_time_allowance_rates(
    p_site_id uuid,
    p_category_id uuid,
    p_user_id uuid,
    p_rates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
    v_id uuid;
    v_num text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_site_id is null and p_category_id is null and p_user_id is null then raise exception 'CHOOSE A SITE, A CATEGORY OR A PERSON'; end if;
    if p_category_id is not null and p_user_id is not null then raise exception 'CHOOSE A CATEGORY OR A PERSON, NOT BOTH'; end if;
    if p_site_id is not null and not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;
    if p_category_id is not null and not exists (select 1 from allowance_categories where id = p_category_id and organization_id = v_org) then raise exception 'CATEGORY NOT FOUND'; end if;
    if p_user_id is not null and not exists (select 1 from users where id = p_user_id and organization_id = v_org) then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not v_owner then
        if not public.prosm_time_user_has_permission_internal(v_caller, 'allowances.approve') then
            raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED';
        end if;
        if p_user_id is not null then
            if not public.prosm_time_caller_has_authority_over(p_user_id, p_site_id) then
                raise exception 'YOU CAN ONLY PRICE PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE';
            end if;
        elsif p_site_id is null or not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
            raise exception 'ONLY THE OWNER SETS PRICES FOR EVERY SITE - CHOOSE A SITE YOU MANAGE';
        end if;
    end if;

    foreach v_num in array array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other', 'overtimeHour', 'extraDay'] loop
        if p_rates ? v_num and jsonb_typeof(p_rates -> v_num) not in ('number', 'null') then
            raise exception 'INVALID PRICE FOR %', v_num;
        end if;
        if jsonb_typeof(p_rates -> v_num) = 'number' and (p_rates ->> v_num)::numeric < 0 then
            raise exception 'A PRICE CANNOT BE NEGATIVE';
        end if;
    end loop;

    select id into v_id from allowance_rates
    where organization_id = v_org
      and site_id is not distinct from p_site_id
      and category_id is not distinct from p_category_id
      and user_id is not distinct from p_user_id;

    if v_id is null then
        insert into allowance_rates (organization_id, site_id, category_id, user_id)
        values (v_org, p_site_id, p_category_id, p_user_id) returning id into v_id;
    end if;

    update allowance_rates set
        meal = (p_rates ->> 'meal')::numeric,
        expatriation = (p_rates ->> 'expatriation')::numeric,
        transportation = (p_rates ->> 'transportation')::numeric,
        housing = (p_rates ->> 'housing')::numeric,
        travel = (p_rates ->> 'travel')::numeric,
        other = (p_rates ->> 'other')::numeric,
        overtime_hour = (p_rates ->> 'overtimeHour')::numeric,
        extra_day = (p_rates ->> 'extraDay')::numeric,
        updated_by = v_caller,
        updated_at = now()
    where id = v_id;

    -- A scope with no price left is removed.
    delete from allowance_rates
    where id = v_id and meal is null and expatriation is null and transportation is null and housing is null
      and travel is null and other is null and overtime_hour is null and extra_day is null;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (v_org, v_caller, p_user_id, 'ALLOWANCE_RATES_SET', 'allowance_rates', v_id, 'Allowance prices set.',
            jsonb_build_object('siteId', p_site_id, 'categoryId', p_category_id, 'rates', p_rates));

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.set_prosm_time_allowance_rates(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_prosm_time_allowance_rates(uuid, uuid, uuid, jsonb) to authenticated;

-- Categories: the Owner and allowance reviewers name them; a person joins one.
create or replace function public.save_prosm_time_allowance_category(p_category_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_user_has_permission_internal(v_caller, 'allowances.approve')) then
        raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED';
    end if;
    if p_name is null or length(trim(p_name)) = 0 then raise exception 'A CATEGORY NEEDS A NAME'; end if;
    if p_category_id is null then
        insert into allowance_categories (organization_id, name) values (v_org, trim(p_name)) returning id into v_id;
    else
        update allowance_categories set name = trim(p_name) where id = p_category_id and organization_id = v_org returning id into v_id;
        if v_id is null then raise exception 'CATEGORY NOT FOUND'; end if;
    end if;
    return jsonb_build_object('success', true, 'categoryId', v_id);
exception
    when unique_violation then raise exception 'A CATEGORY WITH THIS NAME ALREADY EXISTS';
end;
$function$;

create or replace function public.delete_prosm_time_allowance_category(p_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER MAY DELETE A CATEGORY'; end if;
    delete from allowance_categories where id = p_category_id and organization_id = public.current_prosm_time_organization_id();
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.set_prosm_time_allowance_category_member(p_user_id uuid, p_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(v_caller, 'allowances.approve') and public.prosm_time_caller_has_authority_over(p_user_id))
    ) then
        raise exception 'YOU CAN ONLY SET THE CATEGORY OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE';
    end if;
    if p_category_id is null then
        delete from allowance_category_members where user_id = p_user_id and organization_id = v_org;
    else
        if not exists (select 1 from allowance_categories where id = p_category_id and organization_id = v_org) then raise exception 'CATEGORY NOT FOUND'; end if;
        insert into allowance_category_members (user_id, category_id, organization_id) values (p_user_id, p_category_id, v_org)
        on conflict (user_id) do update set category_id = excluded.category_id;
    end if;
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.save_prosm_time_allowance_category(uuid, text) from public, anon;
revoke all on function public.delete_prosm_time_allowance_category(uuid) from public, anon;
revoke all on function public.set_prosm_time_allowance_category_member(uuid, uuid) from public, anon;
grant execute on function public.save_prosm_time_allowance_category(uuid, text) to authenticated;
grant execute on function public.delete_prosm_time_allowance_category(uuid) to authenticated;
grant execute on function public.set_prosm_time_allowance_category_member(uuid, uuid) to authenticated;

-- ============================================================
-- A day's allowances: a new day starts from the prices of the site worked
-- that day (a field the employee leaves at 0); overtime hours and extra
-- days are priced on every save. Otherwise as 20261018110000.
-- ============================================================

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
    v_session_id uuid;
    v_site_id uuid;
    v_overtime_minutes double precision := 0;
    v_overtime_days numeric;
    v_rates jsonb;
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
    -- Owner 2026-10-18: the employee may keep editing until a manager approves.
    if v_existing_status = 'approved' then
        raise exception 'THIS ALLOWANCE ENTRY IS ALREADY APPROVED';
    end if;
    v_new := v_existing_status is null;

    select ats.id, coalesce(ats.site_id, ats.responsible_site_id) into v_session_id, v_site_id
    from attendance_sessions ats
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date
    order by ats.clock_in_at desc
    limit 1;

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
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date;
    v_overtime_days := case when v_overtime_minutes > 0 then 1 else 0 end;

    v_rates := public.prosm_time_resolve_allowance_rates(v_caller_id, v_site_id);

    -- Owner 2026-10-20: a new day starts from the prices (what has no price stays for the employee to type).
    if v_new then
        if v_meal = 0 then v_meal := coalesce((v_rates ->> 'meal')::numeric, 0); end if;
        if v_expatriation = 0 then v_expatriation := coalesce((v_rates ->> 'expatriation')::numeric, 0); end if;
        if v_transportation = 0 then v_transportation := coalesce((v_rates ->> 'transportation')::numeric, 0); end if;
        if v_housing = 0 then v_housing := coalesce((v_rates ->> 'housing')::numeric, 0); end if;
        if v_travel = 0 then v_travel := coalesce((v_rates ->> 'travel')::numeric, 0); end if;
        if v_other = 0 then v_other := coalesce((v_rates ->> 'other')::numeric, 0); end if;
    end if;

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance,
        housing_allowance, travel_allowance, other_allowance, other_allowance_note,
        overtime_hours, overtime_days, overtime_amount, extra_days_amount, status, updated_at
    ) values (
        v_caller_org, v_caller_id, v_session_id, p_entry_date,
        v_meal, v_expatriation, v_transportation, v_housing, v_travel, v_other, p_other_allowance_note,
        round((v_overtime_minutes / 60)::numeric, 2), v_overtime_days,
        round((v_overtime_minutes / 60)::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0), 2),
        round(v_overtime_days * coalesce((v_rates ->> 'extraDay')::numeric, 0), 2),
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
        attendance_session_id = excluded.attendance_session_id,
        overtime_hours = excluded.overtime_hours,
        overtime_days = excluded.overtime_days,
        overtime_amount = excluded.overtime_amount,
        extra_days_amount = excluded.extra_days_amount,
        -- still waiting for review with the new values; a rejected entry goes back to draft to be resubmitted
        status = case when allowance_entries.status = 'rejected' then 'draft' else allowance_entries.status end,
        updated_at = now()
    returning id into v_entry_id;

    return jsonb_build_object('success', true, 'entryId', v_entry_id);
exception
    when others then
        raise exception 'UPSERT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

-- Every day the caller worked in a period, filled from the prices (days
-- already started are left as they are).
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
        select distinct ats.clock_in_at::date from attendance_sessions ats
        where ats.user_id = v_caller and ats.clock_in_at::date between p_from and p_to
          and not exists (select 1 from allowance_entries e where e.user_id = v_caller and e.entry_date = ats.clock_in_at::date)
        order by 1
    loop
        perform public.upsert_prosm_time_allowance_entry(v_day);
        v_count := v_count + 1;
    end loop;
    return jsonb_build_object('success', true, 'filled', v_count);
end;
$function$;

revoke all on function public.fill_prosm_time_allowances(date, date) from public, anon;
grant execute on function public.fill_prosm_time_allowances(date, date) to authenticated;

commit;
