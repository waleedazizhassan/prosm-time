-- PROSM Time v2.3.43, step 7 (item 25): leave types become settings
-- (leave_types, one row per type per organisation) instead of the fixed
-- list (annual, sick, unpaid, emergency, other).
-- Starting values come from press reports on Egypt's Labour Law No. 14 of
-- 2025 (in force 1 September 2025) and MUST be checked against the
-- official text - every value is an editable setting, nothing is a
-- constant in the code:
--   annual      15 days in the first year, 21 from the second, 30 after 10
--               years of service, 45 for people with special needs (or who
--               support a first-degree relative with them);
--   emergency   (casual / "عارضة") 7 days a year, at most 2 days at a time;
--   hajj        a month (30 days), once in the whole service, after 5 years;
--   bereavement 3 days (spouse or first-degree relative);
--   paternity   1 paid day, at most 3 times in the whole service;
--   sick        with a medical report (document required);
--   unpaid, other.
-- Public holidays are paid (the work calendar, step 3).
-- Entitlements come from the hire date (users.hire_date, new). Balances
-- already set (leave_entitlements rows) are never recalculated: a set
-- entitlement wins, the computed one is shown beside it for the manager
-- to review; without a hire date the organisation's old default applies.
-- Managed with leave.manage_types (the Owner).

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('leave.manage_types', 'leave', 'ADMINISTER', 'Manage leave types', 'Leave types, their balances and rules for the organisation.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'leave.manage_types'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

alter table public.users add column if not exists hire_date date;
alter table public.users add column if not exists special_needs_entitlement boolean not null default false;

create table if not exists public.leave_types (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
    name text not null check (length(trim(name)) between 1 and 80),
    is_paid boolean not null default true,
    -- days per year: a fixed number, or tiers by years of service
    annual_days numeric check (annual_days >= 0),
    service_tiers jsonb,
    special_needs_days numeric check (special_needs_days >= 0),
    enforce_balance boolean not null default false,
    max_days_per_request numeric check (max_days_per_request > 0),
    max_times_in_service integer check (max_times_in_service > 0),
    min_service_years numeric check (min_service_years >= 0),
    requires_document boolean not null default false,
    is_active boolean not null default true,
    sort_order integer not null default 100,
    legal_note text,
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    unique (organization_id, key)
);

alter table public.leave_types enable row level security;
revoke all on public.leave_types from anon, authenticated;
grant select on public.leave_types to authenticated;
drop policy if exists "leave types visible to the organisation" on public.leave_types;
create policy "leave types visible to the organisation" on public.leave_types
for select to authenticated using (organization_id = public.current_prosm_time_organization_id());

-- The starting set for an organisation (only types it does not have yet).
create or replace function public.prosm_time_seed_leave_types(p_organization_id uuid)
returns void
language sql
security definer
set search_path = public
as $function$
    insert into leave_types (organization_id, key, name, is_paid, annual_days, service_tiers, special_needs_days, enforce_balance,
                             max_days_per_request, max_times_in_service, min_service_years, requires_document, sort_order, legal_note)
    values
        (p_organization_id, 'annual', 'Annual', true, null,
         '[{"minYears":0,"days":15},{"minYears":1,"days":21},{"minYears":10,"days":30}]'::jsonb, 45, false, null, null, null, false, 10,
         'Law 14/2025 (press reports): 15 days in the first year, 21 from the second, 30 after 10 years, 45 for special needs. Check the official text.'),
        (p_organization_id, 'emergency', 'Casual', true, 7, null, null, true, 2, null, null, false, 20,
         'Law 14/2025 (press reports): 7 days a year, at most 2 at a time. Check the official text.'),
        (p_organization_id, 'sick', 'Sick', true, null, null, null, false, null, null, null, true, 30,
         'With a medical report.'),
        (p_organization_id, 'unpaid', 'Unpaid', false, null, null, null, false, null, null, null, false, 40, null),
        (p_organization_id, 'hajj', 'Hajj or Umrah', true, null, null, null, false, 30, 1, 5, false, 50,
         'Law 14/2025 (press reports): a month, once in the service, after 5 years. Check the official text.'),
        (p_organization_id, 'bereavement', 'Bereavement', true, null, null, null, false, 3, null, null, false, 60,
         'Law 14/2025 (press reports): 3 days for a spouse or a first-degree relative. Check the official text.'),
        (p_organization_id, 'paternity', 'Paternity', true, null, null, null, false, 1, 3, null, false, 70,
         'Law 14/2025 (press reports): 1 paid day, at most 3 times in the service. Check the official text.'),
        (p_organization_id, 'other', 'Other', true, null, null, null, false, null, null, null, false, 90, null)
    on conflict (organization_id, key) do nothing;
$function$;

revoke all on function public.prosm_time_seed_leave_types(uuid) from public, anon, authenticated;

select public.prosm_time_seed_leave_types(id) from public.organizations;

create or replace function public.prosm_time_seed_leave_types_for_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    perform public.prosm_time_seed_leave_types(new.organization_id);
    return new;
end;
$function$;

revoke all on function public.prosm_time_seed_leave_types_for_new_organization() from public, anon, authenticated;

drop trigger if exists organization_settings_seed_leave_types on public.organization_settings;
create trigger organization_settings_seed_leave_types
after insert on public.organization_settings
for each row execute function public.prosm_time_seed_leave_types_for_new_organization();

-- Any key of the organisation's types (the fixed lists go).
alter table public.leave_requests drop constraint if exists leave_requests_leave_type_check;
alter table public.leave_entitlements drop constraint if exists leave_entitlements_leave_type_check;
alter table public.leave_requests add column if not exists document_path text;

-- Medical reports and other leave documents: private, the person's own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('leave-documents', 'leave-documents', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "user uploads own leave document" on storage.objects;
create policy "user uploads own leave document" on storage.objects for insert to authenticated
with check (
    bucket_id = 'leave-documents'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text
);

drop policy if exists "leave documents visible to the person or their reviewers" on storage.objects;
create policy "leave documents visible to the person or their reviewers" on storage.objects for select to authenticated
using (
    bucket_id = 'leave-documents'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (
        (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text
        or public.current_prosm_time_user_is_owner()
        or (
            'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and public.prosm_time_caller_has_authority_over(((storage.foldername(name))[2])::uuid)
        )
    )
);

-- ------------------------------------------------------------------
-- Entitlement of a type for a person in a year.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_service_years(p_user_id uuid, p_on date)
returns numeric
language sql
stable
security definer
set search_path = public
as $function$
    select case when u.hire_date is null then null
                else greatest(extract(epoch from age(p_on, u.hire_date)) / (365.25 * 86400), 0) end
    from users u where u.id = p_user_id;
$function$;

revoke all on function public.prosm_time_service_years(uuid, date) from public, anon, authenticated;

-- jsonb: computed (from the type's rules), set (an entitlement row, if any), entitled (set wins).
create or replace function public.prosm_time_leave_entitlement(p_user_id uuid, p_type leave_types, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_years numeric := public.prosm_time_service_years(p_user_id, make_date(p_year, 1, 1));
    v_special boolean := coalesce((select special_needs_entitlement from users where id = p_user_id), false);
    v_computed numeric;
    v_set numeric;
    v_tier jsonb;
begin
    if p_type.service_tiers is not null then
        if v_years is null then
            -- no hire date: the organisation's earlier default (unchanged behaviour)
            select default_annual_leave_days into v_computed from organization_settings where organization_id = p_type.organization_id;
        else
            for v_tier in select * from jsonb_array_elements(p_type.service_tiers) order by (value ->> 'minYears')::numeric loop
                if v_years >= (v_tier ->> 'minYears')::numeric then v_computed := (v_tier ->> 'days')::numeric; end if;
            end loop;
        end if;
        if v_special and p_type.special_needs_days is not null then v_computed := greatest(coalesce(v_computed, 0), p_type.special_needs_days); end if;
    else
        v_computed := p_type.annual_days;
    end if;
    select entitled_days into v_set from leave_entitlements where user_id = p_user_id and leave_type = p_type.key and year = p_year;
    return jsonb_build_object('computed', v_computed, 'set', v_set, 'entitled', coalesce(v_set, v_computed), 'serviceYears', round(v_years, 2));
end;
$function$;

revoke all on function public.prosm_time_leave_entitlement(uuid, leave_types, integer) from public, anon, authenticated;

create or replace function public.get_prosm_time_leave_balance(p_user_id uuid default null, p_year integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_target_id uuid;
    v_year integer;
    v_result jsonb := '[]'::jsonb;
    v_type leave_types%rowtype;
    v_used numeric;
    v_pending numeric;
    v_ent jsonb;
    v_times integer;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    v_target_id := coalesce(p_user_id, v_caller_id);
    v_org := public.current_prosm_time_organization_id();
    v_year := coalesce(p_year, extract(year from (now() at time zone public.prosm_time_site_timezone(null, v_org)))::integer);

    if v_target_id <> v_caller_id and not (
        public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve')
        and public.prosm_time_caller_sees_person(v_target_id)
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS EMPLOYEE''S LEAVE BALANCE';
    end if;

    for v_type in select * from leave_types where organization_id = v_org and is_active order by sort_order, name loop
        select coalesce(sum(days_count), 0) into v_used
        from leave_requests where user_id = v_target_id and leave_type = v_type.key and status = 'approved' and extract(year from start_date) = v_year;
        select coalesce(sum(days_count), 0) into v_pending
        from leave_requests where user_id = v_target_id and leave_type = v_type.key and status = 'pending' and extract(year from start_date) = v_year;
        select count(*) into v_times from leave_requests where user_id = v_target_id and leave_type = v_type.key and status = 'approved';
        v_ent := public.prosm_time_leave_entitlement(v_target_id, v_type, v_year);
        v_result := v_result || jsonb_build_object(
            'leaveType', v_type.key, 'name', v_type.name, 'isPaid', v_type.is_paid,
            'entitledDays', v_ent -> 'entitled', 'computedDays', v_ent -> 'computed', 'setDays', v_ent -> 'set',
            'differs', (v_ent -> 'set') is not null and (v_ent -> 'computed') is not null and (v_ent ->> 'set')::numeric <> (v_ent ->> 'computed')::numeric,
            'usedDays', v_used, 'pendingDays', v_pending,
            'remainingDays', case when (v_ent -> 'entitled') is null or jsonb_typeof(v_ent -> 'entitled') = 'null' then null else (v_ent ->> 'entitled')::numeric - v_used - v_pending end,
            'timesUsedInService', v_times, 'maxTimesInService', v_type.max_times_in_service,
            'maxDaysPerRequest', v_type.max_days_per_request, 'requiresDocument', v_type.requires_document,
            'serviceYears', v_ent -> 'serviceYears'
        );
    end loop;

    return jsonb_build_object('success', true, 'year', v_year, 'balances', v_result);
exception
    when others then
        raise exception 'GET PROSM TIME LEAVE BALANCE FAILED: %', sqlerrm;
end;
$function$;

-- ------------------------------------------------------------------
-- A request follows its type's rules (owner auto-approval and the
-- notifications as before, 20260916500000 / 20261019130000).
-- ------------------------------------------------------------------
create or replace function public.prosm_time_check_leave_rules(p_user_id uuid, p_type text, p_start date, p_end date, p_document_path text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_type leave_types%rowtype;
    v_days numeric := (p_end - p_start) + 1;
    v_years numeric;
    v_ent jsonb;
    v_used numeric;
begin
    select t.* into v_type from leave_types t join users u on u.organization_id = t.organization_id
    where u.id = p_user_id and t.key = p_type and t.is_active;
    if v_type.id is null then raise exception 'INVALID LEAVE TYPE'; end if;
    if v_type.max_days_per_request is not null and v_days > v_type.max_days_per_request then
        raise exception 'THIS LEAVE TYPE ALLOWS AT MOST % DAYS AT A TIME', v_type.max_days_per_request;
    end if;
    if v_type.min_service_years is not null then
        v_years := public.prosm_time_service_years(p_user_id, p_start);
        if v_years is null or v_years < v_type.min_service_years then
            raise exception 'THIS LEAVE TYPE NEEDS % YEARS OF SERVICE', v_type.min_service_years;
        end if;
    end if;
    if v_type.max_times_in_service is not null and (
        select count(*) from leave_requests where user_id = p_user_id and leave_type = p_type and status in ('pending', 'approved')
    ) >= v_type.max_times_in_service then
        raise exception 'THIS LEAVE TYPE CAN BE TAKEN AT MOST % TIMES IN THE SERVICE', v_type.max_times_in_service;
    end if;
    if v_type.requires_document and nullif(trim(coalesce(p_document_path, '')), '') is null then
        raise exception 'THIS LEAVE TYPE NEEDS A DOCUMENT';
    end if;
    if p_document_path is not null and split_part(p_document_path, '/', 2) <> p_user_id::text then
        raise exception 'INVALID DOCUMENT';
    end if;
    if v_type.enforce_balance then
        v_ent := public.prosm_time_leave_entitlement(p_user_id, v_type, extract(year from p_start)::integer);
        select coalesce(sum(days_count), 0) into v_used from leave_requests
        where user_id = p_user_id and leave_type = p_type and status in ('pending', 'approved') and extract(year from start_date) = extract(year from p_start);
        if (v_ent ->> 'entitled') is not null and v_used + v_days > (v_ent ->> 'entitled')::numeric then
            raise exception 'NOT ENOUGH LEAVE BALANCE';
        end if;
    end if;
end;
$function$;

revoke all on function public.prosm_time_check_leave_rules(uuid, text, date, date, text) from public, anon, authenticated;

drop function if exists public.request_prosm_time_leave(text, date, date, text);
create or replace function public.request_prosm_time_leave(p_leave_type text, p_start_date date, p_end_date date, p_reason text default null, p_document_path text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_caller_name text;
    v_days numeric;
    v_request_id uuid;
    v_has_overlap boolean;
    v_caller_is_owner boolean;
    v_caller_is_reviewer boolean;
    v_notified boolean := false;
    v_has_attendance boolean;
    v_recipient record;
    v_document text := nullif(trim(coalesce(p_document_path, '')), '');
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    if p_end_date < p_start_date then
        raise exception 'END DATE MUST NOT BE BEFORE START DATE';
    end if;
    perform public.prosm_time_check_leave_rules(v_caller_id, p_leave_type, p_start_date, p_end_date, v_document);

    select exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status in ('pending', 'approved')
          and p_start_date <= end_date and p_end_date >= start_date
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'YOU ALREADY HAVE A PENDING OR APPROVED LEAVE REQUEST OVERLAPPING THESE DATES';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_days := (p_end_date - p_start_date) + 1;
    v_caller_is_owner := public.current_prosm_time_user_is_owner();

    if v_caller_is_owner then
        select exists (
            select 1 from attendance_sessions
            where user_id = v_caller_id
            and clock_in_at::date between p_start_date and p_end_date
        ) into v_has_attendance;
        if v_has_attendance then
            raise exception 'YOU HAVE ATTENDANCE RECORDED DURING THESE DATES - RESOLVE THE ATTENDANCE RECORD BEFORE REQUESTING LEAVE FOR THIS PERIOD';
        end if;

        insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, status, reviewed_by, reviewed_at, document_path)
        values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), 'approved', v_caller_id, now(), v_document)
        returning id into v_request_id;

        return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', true);
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, document_path)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), v_document)
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;

    v_caller_is_reviewer := 'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]));

    if v_caller_is_reviewer then
        for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                   'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
            );
        end loop;
    else
        for v_recipient in
            select distinct u.id from users u
            join site_assignments msa on msa.user_id = u.id and msa.role_at_site = 'manager'
            join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = v_caller_id
            where u.organization_id = v_org and u.is_active and not u.is_owner and u.id <> v_caller_id
              and public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_caller_id)
        loop
            v_notified := true;
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                   'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
            );
        end loop;
        if not v_notified then
            for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
            loop
                perform public.create_prosm_time_notification(
                    v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                    v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                    'leave_requests', v_request_id,
                    jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                       'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
                );
            end loop;
        end if;
    end if;

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', false);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.request_prosm_time_leave(text, date, date, text, text) from public, anon;
grant execute on function public.request_prosm_time_leave(text, date, date, text, text) to authenticated;

-- Entitlements may be set for any type of the organisation.
do $$
declare
    v_def text;
    v_anchor constant text := 'if p_leave_type not in (''annual'', ''sick'', ''unpaid'', ''emergency'', ''other'') then';
begin
    v_def := pg_get_functiondef('public.set_prosm_time_leave_entitlement(uuid, text, integer, numeric)'::regprocedure);
    if position(v_anchor in v_def) = 0 then raise exception 'set_prosm_time_leave_entitlement changed - type check not found'; end if;
    execute replace(v_def, v_anchor,
        'if not exists (select 1 from leave_types where organization_id = public.current_prosm_time_organization_id() and key = p_leave_type) then');
end;
$$;

-- ------------------------------------------------------------------
-- Managing the types (leave.manage_types) and employment details.
-- ------------------------------------------------------------------
create or replace function public.save_prosm_time_leave_type(p_id uuid, p_key text, p_type jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_before leave_types%rowtype;
    v_id uuid;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'leave.manage_types') then raise exception 'LEAVE.MANAGE_TYPES AUTHORITY REQUIRED'; end if;
    if p_id is not null then
        select * into v_before from leave_types where id = p_id and organization_id = v_org;
        if v_before.id is null then raise exception 'LEAVE TYPE NOT FOUND'; end if;
    end if;
    begin
        if p_id is null then
            insert into leave_types (organization_id, key, name) values (v_org, lower(trim(p_key)), coalesce(nullif(trim(p_type ->> 'name'), ''), lower(trim(p_key))))
            returning id into v_id;
        else
            v_id := p_id;
        end if;
        update leave_types set
            name = coalesce(nullif(trim(p_type ->> 'name'), ''), name),
            is_paid = coalesce((p_type ->> 'isPaid')::boolean, is_paid),
            annual_days = (p_type ->> 'annualDays')::numeric,
            service_tiers = case when jsonb_typeof(p_type -> 'serviceTiers') = 'array' then p_type -> 'serviceTiers' else null end,
            special_needs_days = (p_type ->> 'specialNeedsDays')::numeric,
            enforce_balance = coalesce((p_type ->> 'enforceBalance')::boolean, false),
            max_days_per_request = (p_type ->> 'maxDaysPerRequest')::numeric,
            max_times_in_service = (p_type ->> 'maxTimesInService')::integer,
            min_service_years = (p_type ->> 'minServiceYears')::numeric,
            requires_document = coalesce((p_type ->> 'requiresDocument')::boolean, false),
            is_active = coalesce((p_type ->> 'isActive')::boolean, true),
            sort_order = coalesce((p_type ->> 'sortOrder')::integer, sort_order),
            updated_by = v_caller, updated_at = now()
        where id = v_id;
    exception
        when check_violation or invalid_text_representation then raise exception 'INVALID LEAVE TYPE SETTINGS';
        when unique_violation then raise exception 'A LEAVE TYPE WITH THIS KEY ALREADY EXISTS';
    end;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_caller, 'leave.type_saved', 'leave_types', v_id, 'Leave type saved (applies to coming entitlements only)',
            case when v_before.id is null then null else to_jsonb(v_before) end, (select to_jsonb(t) from leave_types t where t.id = v_id));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$function$;

create or replace function public.set_prosm_time_employment_details(p_user_id uuid, p_hire_date date, p_special_needs boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_before users%rowtype;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_before from users where id = p_user_id and organization_id = public.current_prosm_time_organization_id();
    if v_before.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(v_caller, 'employees.edit') and public.prosm_time_caller_has_authority_over(p_user_id))
    ) then
        raise exception 'EMPLOYEES.EDIT AUTHORITY REQUIRED';
    end if;
    if p_hire_date is not null and p_hire_date > current_date then raise exception 'THE HIRE DATE CANNOT BE IN THE FUTURE'; end if;
    update users set hire_date = p_hire_date, special_needs_entitlement = coalesce(p_special_needs, false), updated_at = now() where id = p_user_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_before.organization_id, v_caller, p_user_id, 'employees.employment_details', 'users', p_user_id, 'Hire date / special-needs entitlement changed',
            jsonb_build_object('hireDate', v_before.hire_date, 'specialNeeds', v_before.special_needs_entitlement),
            jsonb_build_object('hireDate', p_hire_date, 'specialNeeds', coalesce(p_special_needs, false)));
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.get_prosm_time_employment_details(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_caller_sees_person(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    return (select jsonb_build_object('hireDate', hire_date, 'specialNeeds', special_needs_entitlement,
                                      'serviceYears', round(public.prosm_time_service_years(id, current_date), 2))
            from users where id = p_user_id);
end;
$function$;

revoke all on function public.save_prosm_time_leave_type(uuid, text, jsonb) from public, anon;
revoke all on function public.set_prosm_time_employment_details(uuid, date, boolean) from public, anon;
revoke all on function public.get_prosm_time_employment_details(uuid) from public, anon;
grant execute on function public.save_prosm_time_leave_type(uuid, text, jsonb) to authenticated;
grant execute on function public.set_prosm_time_employment_details(uuid, date, boolean) to authenticated;
grant execute on function public.get_prosm_time_employment_details(uuid) to authenticated;

commit;
