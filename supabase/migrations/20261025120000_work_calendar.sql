-- PROSM Time v2.3.43, step 3 (items 7 and 8): a work calendar.
-- Until now shifts were set by date only, and "extra day" / overtime days
-- had no calendar behind them. Now:
--   * public holidays (name, a date or a range, for the organisation or one site);
--   * weekly rest days: the organisation's (Friday by default, the week
--     starting on Saturday), a site's own, or a shift template's own;
--   * exceptional days (schedule_exceptions): a date or a range, for the
--     organisation, a site, a shift template or one person, with other
--     hours and/or "no deduction" (e.g. Thursday: everyone leaves at 4 pm,
--     no late/early deduction), a reason, audited.
-- Calculation rule: work on a weekly rest day or a public holiday is
-- overtime (the timesheet counts the whole day as overtime; allowances
-- price it as an extra day - step 4). An exceptional day with "no
-- deduction" produces no late deduction.
-- Days are counted in the site's time zone (Africa/Cairo by default), no
-- longer in UTC.
-- Managed by calendar.manage (Owner, Managers for the sites they manage;
-- organisation-wide entries: the Owner).

begin;

alter table public.organization_settings add column if not exists timezone text not null default 'Africa/Cairo';
alter table public.organization_settings add column if not exists week_start_day smallint not null default 6;
alter table public.organization_settings add column if not exists rest_days smallint[] not null default array[5]::smallint[];
alter table public.organization_settings drop constraint if exists organization_settings_week_start_day_check;
alter table public.organization_settings add constraint organization_settings_week_start_day_check check (week_start_day between 0 and 6);

alter table public.sites add column if not exists rest_days smallint[];
alter table public.shift_templates add column if not exists rest_days smallint[];

create or replace function public.prosm_time_valid_weekdays(p_days smallint[])
returns boolean
language sql
immutable
set search_path = public
as $function$
    select p_days is null or (cardinality(p_days) <= 7 and not exists (select 1 from unnest(p_days) d where d not between 0 and 6));
$function$;

alter table public.organization_settings drop constraint if exists organization_settings_rest_days_check;
alter table public.organization_settings add constraint organization_settings_rest_days_check check (public.prosm_time_valid_weekdays(rest_days));
alter table public.sites drop constraint if exists sites_rest_days_check;
alter table public.sites add constraint sites_rest_days_check check (public.prosm_time_valid_weekdays(rest_days));
alter table public.shift_templates drop constraint if exists shift_templates_rest_days_check;
alter table public.shift_templates add constraint shift_templates_rest_days_check check (public.prosm_time_valid_weekdays(rest_days));

create table if not exists public.public_holidays (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 120),
    start_date date not null,
    end_date date not null,
    is_paid boolean not null default true,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (end_date >= start_date and end_date - start_date <= 31)
);
create index if not exists public_holidays_org_dates_idx on public.public_holidays (organization_id, start_date, end_date);

create table if not exists public.schedule_exceptions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    shift_template_id uuid references public.shift_templates(id) on delete cascade,
    user_id uuid references public.users(id) on delete cascade,
    start_date date not null,
    end_date date not null,
    start_time time,
    end_time time,
    is_day_off boolean not null default false,
    no_deduction boolean not null default false,
    reason text not null check (length(trim(reason)) between 1 and 500),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (end_date >= start_date and end_date - start_date <= 92),
    check (num_nonnulls(site_id, shift_template_id, user_id) <= 1),
    check (start_time is null or end_time is null or end_time <> start_time)
);
create index if not exists schedule_exceptions_org_dates_idx on public.schedule_exceptions (organization_id, start_date, end_date);

alter table public.public_holidays enable row level security;
alter table public.schedule_exceptions enable row level security;
revoke all on public.public_holidays, public.schedule_exceptions from anon, authenticated;
grant select on public.public_holidays, public.schedule_exceptions to authenticated;

-- Everyone in the organisation sees the holidays; exceptions for one person
-- are seen by that person and by whoever sees them.
drop policy if exists "holidays visible to the organisation" on public.public_holidays;
create policy "holidays visible to the organisation" on public.public_holidays
for select to authenticated using (organization_id = public.current_prosm_time_organization_id());

drop policy if exists "schedule exceptions visible in scope" on public.schedule_exceptions;
create policy "schedule exceptions visible in scope" on public.schedule_exceptions
for select to authenticated using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id is null or public.prosm_time_caller_sees_person(user_id))
);

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('calendar.manage', 'calendar', 'ADMINISTER', 'Manage the work calendar',
        'Public holidays, weekly rest days and exceptional days for the sites one manages (organisation-wide: the Owner).')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'calendar.manage'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

-- ------------------------------------------------------------------
-- What kind of day is it for this person at this site?
-- ------------------------------------------------------------------

-- The time zone a site counts its days in.
create or replace function public.prosm_time_site_timezone(p_site_id uuid, p_organization_id uuid default null)
returns text
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(
        (select s.timezone from sites s where s.id = p_site_id and s.timezone is not null and s.timezone <> 'UTC'),
        (select os.timezone from organization_settings os where os.organization_id = coalesce(p_organization_id, (select organization_id from sites where id = p_site_id))),
        'Africa/Cairo'
    );
$function$;

-- The work date of a moment at a site (the shift belongs to the day it started).
create or replace function public.prosm_time_work_date(p_at timestamptz, p_site_id uuid, p_organization_id uuid default null)
returns date
language sql
stable
security definer
set search_path = public
as $function$
    select (p_at at time zone public.prosm_time_site_timezone(p_site_id, p_organization_id))::date;
$function$;

create or replace function public.prosm_time_rest_days(p_user_id uuid, p_site_id uuid, p_date date)
returns smallint[]
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(
        (select st.rest_days from shift_assignments sa join shift_templates st on st.id = sa.shift_template_id
          where sa.user_id = p_user_id and sa.shift_date = p_date and sa.status = 'scheduled' and st.rest_days is not null
          order by sa.start_time limit 1),
        (select s.rest_days from sites s where s.id = p_site_id),
        (select os.rest_days from organization_settings os join users u on u.organization_id = os.organization_id where u.id = p_user_id),
        array[5]::smallint[]
    );
$function$;

-- 'public_holiday' | 'weekly_rest' | 'workday'
create or replace function public.prosm_time_day_type(p_user_id uuid, p_site_id uuid, p_date date)
returns text
language sql
stable
security definer
set search_path = public
as $function$
    select case
        when exists (
            select 1 from public_holidays h join users u on u.organization_id = h.organization_id
            where u.id = p_user_id and p_date between h.start_date and h.end_date
              and (h.site_id is null or h.site_id = p_site_id)
        ) then 'public_holiday'
        when extract(dow from p_date)::smallint = any(public.prosm_time_rest_days(p_user_id, p_site_id, p_date)) then 'weekly_rest'
        else 'workday'
    end;
$function$;

-- The exceptional day that applies (the most specific: person, shift
-- template, site, organisation; the latest entry wins a tie).
create or replace function public.prosm_time_day_exception(p_user_id uuid, p_site_id uuid, p_date date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    select to_jsonb(x) from (
        select e.id, e.start_time, e.end_time, e.is_day_off, e.no_deduction, e.reason
        from schedule_exceptions e join users u on u.organization_id = e.organization_id
        where u.id = p_user_id and p_date between e.start_date and e.end_date
          and (
              e.user_id = p_user_id
              or e.shift_template_id in (select sa.shift_template_id from shift_assignments sa where sa.user_id = p_user_id and sa.shift_date = p_date and sa.status = 'scheduled')
              or e.site_id = p_site_id
              or (e.user_id is null and e.shift_template_id is null and e.site_id is null)
          )
        order by case when e.user_id is not null then 1 when e.shift_template_id is not null then 2 when e.site_id is not null then 3 else 4 end,
                 e.created_at desc
        limit 1
    ) x;
$function$;

revoke all on function public.prosm_time_rest_days(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.prosm_time_day_type(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.prosm_time_day_exception(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.prosm_time_site_timezone(uuid, uuid) from public, anon;
revoke all on function public.prosm_time_work_date(timestamptz, uuid, uuid) from public, anon;
grant execute on function public.prosm_time_site_timezone(uuid, uuid) to authenticated;
grant execute on function public.prosm_time_work_date(timestamptz, uuid, uuid) to authenticated;

-- ------------------------------------------------------------------
-- Who may change which part of the calendar
-- ------------------------------------------------------------------
create or replace function public.prosm_time_require_calendar_scope(p_site_id uuid, p_shift_template_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_site uuid := p_site_id;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'calendar.manage') then
        raise exception 'CALENDAR.MANAGE AUTHORITY REQUIRED';
    end if;
    if p_shift_template_id is not null then
        select site_id into v_site from shift_templates where id = p_shift_template_id and organization_id = v_org;
        if v_site is null then raise exception 'SHIFT TEMPLATE NOT FOUND'; end if;
    end if;
    if v_site is not null and not exists (select 1 from sites where id = v_site and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;
    if p_user_id is not null and not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if public.current_prosm_time_user_is_owner() then return; end if;
    if p_user_id is not null then
        if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
        return;
    end if;
    if v_site is null then raise exception 'ONLY THE OWNER CHANGES THE ORGANISATION-WIDE CALENDAR'; end if;
    if not (v_site = any(public.current_prosm_time_managed_site_ids())) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
end;
$function$;

revoke all on function public.prosm_time_require_calendar_scope(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.save_prosm_time_holiday(p_id uuid, p_site_id uuid, p_name text, p_start_date date, p_end_date date, p_is_paid boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before public_holidays%rowtype;
    v_id uuid;
begin
    perform public.prosm_time_require_calendar_scope(p_site_id, null, null);
    if p_id is not null then
        select * into v_before from public_holidays where id = p_id and organization_id = v_org;
        if v_before.id is null then raise exception 'HOLIDAY NOT FOUND'; end if;
        perform public.prosm_time_require_calendar_scope(v_before.site_id, null, null);
    end if;
    if p_name is null or length(trim(p_name)) = 0 then raise exception 'A NAME IS REQUIRED'; end if;
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_end_date - p_start_date > 31 then
        raise exception 'INVALID HOLIDAY DATES';
    end if;
    if p_id is null then
        insert into public_holidays (organization_id, site_id, name, start_date, end_date, is_paid, created_by)
        values (v_org, p_site_id, trim(p_name), p_start_date, p_end_date, coalesce(p_is_paid, true), public.current_prosm_time_user_id())
        returning id into v_id;
    else
        update public_holidays set site_id = p_site_id, name = trim(p_name), start_date = p_start_date, end_date = p_end_date,
            is_paid = coalesce(p_is_paid, true), updated_at = now()
        where id = p_id returning id into v_id;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'calendar.holiday_saved', 'public_holidays', v_id, 'Public holiday saved',
            case when v_before.id is null then null else to_jsonb(v_before) end,
            jsonb_build_object('siteId', p_site_id, 'name', trim(p_name), 'startDate', p_start_date, 'endDate', p_end_date, 'isPaid', coalesce(p_is_paid, true)));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$function$;

create or replace function public.delete_prosm_time_holiday(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row public_holidays%rowtype;
begin
    select * into v_row from public_holidays where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_row.id is null then raise exception 'HOLIDAY NOT FOUND'; end if;
    perform public.prosm_time_require_calendar_scope(v_row.site_id, null, null);
    delete from public_holidays where id = p_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state)
    values (v_row.organization_id, public.current_prosm_time_user_id(), 'calendar.holiday_deleted', 'public_holidays', p_id, 'Public holiday deleted', to_jsonb(v_row));
    return jsonb_build_object('success', true);
end;
$function$;

-- Weekly rest days: the organisation's (site and template null), a site's
-- or a shift template's; null days = inherit.
create or replace function public.set_prosm_time_rest_days(p_site_id uuid, p_shift_template_id uuid, p_days smallint[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before smallint[];
    v_days smallint[];
begin
    perform public.prosm_time_require_calendar_scope(p_site_id, p_shift_template_id, null);
    if not public.prosm_time_valid_weekdays(p_days) then raise exception 'INVALID WEEKDAYS'; end if;
    select array_agg(distinct d order by d) into v_days from unnest(p_days) d;
    if p_shift_template_id is not null then
        select rest_days into v_before from shift_templates where id = p_shift_template_id;
        update shift_templates set rest_days = v_days, updated_at = now() where id = p_shift_template_id;
    elsif p_site_id is not null then
        select rest_days into v_before from sites where id = p_site_id;
        update sites set rest_days = v_days, updated_at = now() where id = p_site_id;
    else
        if v_days is null then v_days := array[]::smallint[]; end if;
        select rest_days into v_before from organization_settings where organization_id = v_org;
        update organization_settings set rest_days = v_days where organization_id = v_org;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state, context)
    values (v_org, public.current_prosm_time_user_id(), 'calendar.rest_days_set', coalesce(case when p_shift_template_id is not null then 'shift_templates' end, case when p_site_id is not null then 'sites' end, 'organization_settings'),
            coalesce(p_shift_template_id, p_site_id), 'Weekly rest days changed',
            jsonb_build_object('restDays', v_before), jsonb_build_object('restDays', v_days),
            jsonb_build_object('siteId', p_site_id, 'shiftTemplateId', p_shift_template_id));
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.save_prosm_time_schedule_exception(
    p_id uuid,
    p_site_id uuid,
    p_shift_template_id uuid,
    p_user_id uuid,
    p_start_date date,
    p_end_date date,
    p_start_time time,
    p_end_time time,
    p_is_day_off boolean,
    p_no_deduction boolean,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before schedule_exceptions%rowtype;
    v_id uuid;
begin
    if num_nonnulls(p_site_id, p_shift_template_id, p_user_id) > 1 then raise exception 'CHOOSE ONE SCOPE'; end if;
    perform public.prosm_time_require_calendar_scope(p_site_id, p_shift_template_id, p_user_id);
    if p_id is not null then
        select * into v_before from schedule_exceptions where id = p_id and organization_id = v_org;
        if v_before.id is null then raise exception 'SCHEDULE EXCEPTION NOT FOUND'; end if;
        perform public.prosm_time_require_calendar_scope(v_before.site_id, v_before.shift_template_id, v_before.user_id);
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_end_date - p_start_date > 92 then
        raise exception 'INVALID EXCEPTION DATES';
    end if;
    if p_start_time is not null and p_end_time is not null and p_start_time = p_end_time then
        raise exception 'END TIME MUST BE DIFFERENT FROM START TIME';
    end if;
    if p_id is null then
        insert into schedule_exceptions (organization_id, site_id, shift_template_id, user_id, start_date, end_date, start_time, end_time,
                                         is_day_off, no_deduction, reason, created_by)
        values (v_org, p_site_id, p_shift_template_id, p_user_id, p_start_date, p_end_date, p_start_time, p_end_time,
                coalesce(p_is_day_off, false), coalesce(p_no_deduction, false), trim(p_reason), public.current_prosm_time_user_id())
        returning id into v_id;
    else
        update schedule_exceptions set site_id = p_site_id, shift_template_id = p_shift_template_id, user_id = p_user_id,
            start_date = p_start_date, end_date = p_end_date, start_time = p_start_time, end_time = p_end_time,
            is_day_off = coalesce(p_is_day_off, false), no_deduction = coalesce(p_no_deduction, false), reason = trim(p_reason), updated_at = now()
        where id = p_id returning id into v_id;
    end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'calendar.exception_saved', 'schedule_exceptions', v_id, 'Exceptional day saved', trim(p_reason),
            case when v_before.id is null then null else to_jsonb(v_before) end,
            (select to_jsonb(e) from schedule_exceptions e where e.id = v_id));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$function$;

create or replace function public.delete_prosm_time_schedule_exception(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row schedule_exceptions%rowtype;
begin
    select * into v_row from schedule_exceptions where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_row.id is null then raise exception 'SCHEDULE EXCEPTION NOT FOUND'; end if;
    perform public.prosm_time_require_calendar_scope(v_row.site_id, v_row.shift_template_id, v_row.user_id);
    delete from schedule_exceptions where id = p_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state)
    values (v_row.organization_id, public.current_prosm_time_user_id(), v_row.user_id, 'calendar.exception_deleted', 'schedule_exceptions', p_id,
            'Exceptional day deleted', v_row.reason, to_jsonb(v_row));
    return jsonb_build_object('success', true);
end;
$function$;

-- The calendar between two dates, for the calendar page, the dashboard's
-- "upcoming holidays" and reports.
create or replace function public.get_prosm_time_calendar(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'CHOOSE A PERIOD OF UP TO A YEAR'; end if;
    return jsonb_build_object(
        'restDays', (select to_jsonb(rest_days) from organization_settings where organization_id = v_org),
        'weekStartDay', (select week_start_day from organization_settings where organization_id = v_org),
        'timezone', (select timezone from organization_settings where organization_id = v_org),
        'sites', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'restDays', s.rest_days) order by s.name)
                            from sites s where s.organization_id = v_org and s.is_active), '[]'::jsonb),
        'holidays', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'siteId', h.site_id, 'siteName', s.name, 'name', h.name,
                                      'startDate', h.start_date, 'endDate', h.end_date, 'isPaid', h.is_paid) order by h.start_date)
                               from public_holidays h left join sites s on s.id = h.site_id
                               where h.organization_id = v_org and h.end_date >= p_from and h.start_date <= p_to), '[]'::jsonb),
        'exceptions', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'siteId', e.site_id, 'siteName', s.name,
                                      'shiftTemplateId', e.shift_template_id, 'shiftTemplateName', st.name, 'userId', e.user_id, 'userName', u.full_name,
                                      'startDate', e.start_date, 'endDate', e.end_date, 'startTime', e.start_time, 'endTime', e.end_time,
                                      'isDayOff', e.is_day_off, 'noDeduction', e.no_deduction, 'reason', e.reason) order by e.start_date)
                                 from schedule_exceptions e
                                 left join sites s on s.id = e.site_id
                                 left join shift_templates st on st.id = e.shift_template_id
                                 left join users u on u.id = e.user_id
                                 where e.organization_id = v_org and e.end_date >= p_from and e.start_date <= p_to
                                   and (e.user_id is null or public.prosm_time_caller_sees_person(e.user_id))), '[]'::jsonb)
    );
end;
$function$;

revoke all on function public.save_prosm_time_holiday(uuid, uuid, text, date, date, boolean) from public, anon;
revoke all on function public.delete_prosm_time_holiday(uuid) from public, anon;
revoke all on function public.set_prosm_time_rest_days(uuid, uuid, smallint[]) from public, anon;
revoke all on function public.save_prosm_time_schedule_exception(uuid, uuid, uuid, uuid, date, date, time, time, boolean, boolean, text) from public, anon;
revoke all on function public.delete_prosm_time_schedule_exception(uuid) from public, anon;
revoke all on function public.get_prosm_time_calendar(date, date) from public, anon;
grant execute on function public.save_prosm_time_holiday(uuid, uuid, text, date, date, boolean) to authenticated;
grant execute on function public.delete_prosm_time_holiday(uuid) to authenticated;
grant execute on function public.set_prosm_time_rest_days(uuid, uuid, smallint[]) to authenticated;
grant execute on function public.save_prosm_time_schedule_exception(uuid, uuid, uuid, uuid, date, date, time, time, boolean, boolean, text) to authenticated;
grant execute on function public.delete_prosm_time_schedule_exception(uuid) to authenticated;
grant execute on function public.get_prosm_time_calendar(date, date) to authenticated;

-- ------------------------------------------------------------------
-- Timesheets read the calendar: days in the site's time zone; a rest day
-- or holiday worked is overtime; an exceptional day can carry other hours
-- (its end is where overtime starts, its start is where lateness starts)
-- or no deduction at all.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_deduction_minutes double precision := 0;
    v_leave_days numeric := 0;
    v_exceptions_count integer := 0;
    v_corrections_count integer := 0;
    v_timesheet_id uuid;
    v_existing_status text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_period_end < p_period_start then raise exception 'PERIOD END MUST NOT BE BEFORE PERIOD START'; end if;

    select organization_id into v_org_id from users where id = p_user_id;
    if v_org_id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_org_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over(p_user_id)
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE';
    end if;

    select id, status into v_timesheet_id, v_existing_status
    from timesheets where user_id = p_user_id and period_start = p_period_start and period_end = p_period_end;

    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    with rejected_exception_cap as (
        select
            coalesce(ae.session_id, ps.attendance_session_id) as session_id,
            min(ge.created_at) as cap_at
        from geofence_exceptions ge
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        where ge.user_id = p_user_id
        and exists (
            select 1 from exception_actions ea
            where ea.geofence_exception_id = ge.id
            and ea.action_type = 'rejected'
            and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
        )
        group by coalesce(ae.session_id, ps.attendance_session_id)
    ),
    capped_sessions as (
        select
            ats.id as session_id,
            ats.clock_in_at,
            ats.site_id,
            public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as work_date,
            least(ats.clock_out_at, coalesce(rec.cap_at, ats.clock_out_at)) as effective_clock_out_at
        from attendance_sessions ats
        left join rejected_exception_cap rec on rec.session_id = ats.id
        where ats.user_id = p_user_id
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_period_start and p_period_end
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
    ),
    worked_by_day as (
        select cs.work_date, sum(extract(epoch from (cs.effective_clock_out_at - cs.clock_in_at)) / 60) as worked_minutes
        from capped_sessions cs
        group by cs.work_date
    ),
    threshold_by_day as (
        select distinct on (cs.work_date)
            cs.work_date,
            s.daily_overtime_threshold_minutes as site_threshold,
            coalesce((public.prosm_time_day_exception(p_user_id, cs.site_id, cs.work_date) ->> 'end_time')::time, s.overtime_start_time) as overtime_start_time,
            coalesce((public.prosm_time_day_exception(p_user_id, cs.site_id, cs.work_date) ->> 'start_time')::time, s.late_deduction_start_time) as late_deduction_start_time,
            coalesce((public.prosm_time_day_exception(p_user_id, cs.site_id, cs.work_date) ->> 'no_deduction')::boolean, false) as no_deduction,
            public.prosm_time_day_type(p_user_id, cs.site_id, cs.work_date) as day_type,
            public.prosm_time_site_timezone(cs.site_id, v_org_id) as site_timezone,
            min(cs.clock_in_at) over (partition by cs.work_date) as rep_clock_in_at,
            cs.effective_clock_out_at as rep_clock_out_at
        from capped_sessions cs
        left join sites s on s.id = cs.site_id
        order by cs.work_date, cs.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(
            case
                when t.day_type in ('weekly_rest', 'public_holiday') then w.worked_minutes
                when t.overtime_start_time is not null and t.rep_clock_out_at is not null then
                    least(greatest(extract(epoch from ((t.rep_clock_out_at at time zone t.site_timezone)::time - t.overtime_start_time)) / 60, 0), w.worked_minutes)
                else
                    greatest(w.worked_minutes - coalesce(t.site_threshold, v_org_threshold, 480), 0)
            end
        ), 0),
        coalesce(sum(
            case
                when t.no_deduction or t.day_type in ('weekly_rest', 'public_holiday') then 0
                when t.late_deduction_start_time is not null then
                    greatest(extract(epoch from ((t.rep_clock_in_at at time zone t.site_timezone)::time - t.late_deduction_start_time)) / 60, 0)
                else 0
            end
        ), 0)
    into v_worked_minutes, v_overtime_minutes, v_deduction_minutes
    from worked_by_day w
    left join threshold_by_day t on t.work_date = w.work_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, ats.clock_out_at) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_period_start and p_period_end
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);

    select coalesce(sum(
        least(lr.end_date, p_period_end) - greatest(lr.start_date, p_period_start) + 1
    ), 0)
    into v_leave_days
    from leave_requests lr
    where lr.user_id = p_user_id
      and lr.status = 'approved'
      and lr.start_date <= p_period_end
      and lr.end_date >= p_period_start;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes, total_leave_days,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes, v_leave_days,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
        total_leave_days = excluded.total_leave_days,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    if p_user_id <> v_caller_id then
        perform public.create_prosm_time_notification(
            v_org_id, p_user_id, 'timesheet_ready', 'normal', 'Your timesheet is ready',
            'Review your timesheet for ' || p_period_start || ' - ' || p_period_end || ' and submit it.',
            'timesheets', v_timesheet_id,
            jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end)
        );
    end if;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

commit;
