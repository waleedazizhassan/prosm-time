-- 2026-11-11 HR suite, feature 3 (docs/features/PROSM-new-features-spec.md): the full employee profile -
-- one page with tabs for everything about a person.
--   * users: national id, birth date, address, phone, emergency contact, job title (from the company's
--     own list of job titles), employment status (active / suspended / ended - separate from access).
--   * job_titles: the company's list (used by the profile and by the documents that apply to a job).
--   * employee_contracts: contract type, dates, probation end, the signed file.
--   * hr.manage: a new permission ("manage personnel files") - the owner always; anyone else only when
--     granted (there is no separate HR role; it is given from "Grant permissions").
--   * hr-files: a private storage bucket for contracts and documents, by organisation / person.
--   * get_prosm_time_employee_profile: what the reader may see - full (owner / hr.manage), manager (a
--     manager or supervisor with authority over the person: no payroll, no national id, birth date or
--     address), or self (read only).
--   * the plans: documents and penalties are part of Business and above.
-- Every change is written to the action log, so the profile's History tab shows it.
-- Rollback: drop the functions, employee_contracts, job_titles, the users columns, the bucket and its
-- policies; delete the hr.manage permission; remove documents/penalties from the plans' flags.

begin;

-- ---------------------------------------------------------------- data
create table if not exists public.job_titles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (char_length(trim(name)) between 1 and 80),
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index if not exists job_titles_org_name_idx on public.job_titles (organization_id, lower(trim(name)));
alter table public.job_titles enable row level security;
revoke all on public.job_titles from public, anon, authenticated;

alter table public.users
    add column if not exists national_id text check (national_id is null or char_length(national_id) <= 30),
    add column if not exists birth_date date,
    add column if not exists address text check (address is null or char_length(address) <= 300),
    add column if not exists phone text check (phone is null or char_length(phone) <= 30),
    add column if not exists emergency_contact_name text check (emergency_contact_name is null or char_length(emergency_contact_name) <= 100),
    add column if not exists emergency_contact_phone text check (emergency_contact_phone is null or char_length(emergency_contact_phone) <= 30),
    add column if not exists job_title_id uuid references public.job_titles(id) on delete set null,
    add column if not exists employment_status text not null default 'active' check (employment_status in ('active', 'suspended', 'ended'));

create table if not exists public.employee_contracts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    contract_type text not null check (contract_type in ('fixed_term', 'open_ended', 'temporary')),
    start_date date not null,
    end_date date,
    probation_end_date date,
    file_path text,
    notes text check (notes is null or char_length(notes) <= 500),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (end_date is null or end_date >= start_date),
    check (probation_end_date is null or probation_end_date >= start_date)
);
create index if not exists employee_contracts_user_idx on public.employee_contracts (user_id, start_date desc);
alter table public.employee_contracts enable row level security;
revoke all on public.employee_contracts from public, anon, authenticated;

-- ---------------------------------------------------------------- permission
insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('hr.manage', 'hr', 'ADMINISTER', 'Manage personnel files', 'See and change every part of the employees'' files: personal data, contracts, documents, penalties.')
on conflict (permission_key) do nothing;
insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p where r.role_key = 'owner' and p.permission_key = 'hr.manage'
on conflict (role_id, permission_id) do nothing;

-- the reader manages personnel files (the owner, or hr.manage)
create or replace function public.prosm_time_is_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_is_owner()
        or 'hr.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]));
$$;
revoke all on function public.prosm_time_is_hr() from public, anon;
grant execute on function public.prosm_time_is_hr() to authenticated;

-- how much of a person's file the reader may see: full, manager, self, or none
create or replace function public.prosm_time_profile_access(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select case
        when not exists (select 1 from users where id = p_user_id and organization_id = public.current_prosm_time_organization_id()) then 'none'
        when public.prosm_time_is_hr() then 'full'
        when p_user_id = public.current_prosm_time_user_id() then 'self'
        when public.prosm_time_caller_has_authority_over(p_user_id) then 'manager'
        else 'none'
    end;
$$;
revoke all on function public.prosm_time_profile_access(uuid) from public, anon;
grant execute on function public.prosm_time_profile_access(uuid) to authenticated;

-- ---------------------------------------------------------------- files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hr-files', 'hr-files', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "hr files: personnel managers and the person upload" on storage.objects;
create policy "hr files: personnel managers and the person upload" on storage.objects for insert to authenticated
with check (
    bucket_id = 'hr-files'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (public.prosm_time_is_hr() or (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text)
);

drop policy if exists "hr files: personnel managers and the person read" on storage.objects;
create policy "hr files: personnel managers and the person read" on storage.objects for select to authenticated
using (
    bucket_id = 'hr-files'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (public.prosm_time_is_hr() or (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text)
);

-- ---------------------------------------------------------------- job titles
create or replace function public.list_prosm_time_job_titles()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'isActive', is_active,
                   'people', (select count(*) from users u where u.job_title_id = j.id and u.is_active)) order by is_active desc, lower(name)), '[]'::jsonb)
    from job_titles j where organization_id = public.current_prosm_time_organization_id();
$$;
revoke all on function public.list_prosm_time_job_titles() from public, anon;
grant execute on function public.list_prosm_time_job_titles() to authenticated;

create or replace function public.save_prosm_time_job_title(p_id uuid, p_name text, p_is_active boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'A NAME IS REQUIRED'; end if;
    if exists (select 1 from job_titles where organization_id = v_org and lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
        raise exception 'THIS JOB TITLE ALREADY EXISTS';
    end if;
    if p_id is null then
        insert into job_titles (organization_id, name, is_active) values (v_org, trim(p_name), coalesce(p_is_active, true)) returning id into v_id;
    else
        update job_titles set name = trim(p_name), is_active = coalesce(p_is_active, is_active) where id = p_id and organization_id = v_org returning id into v_id;
        if v_id is null then raise exception 'JOB TITLE NOT FOUND'; end if;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.job_title_saved', 'job_titles', v_id, 'Job title saved',
            jsonb_build_object('name', trim(p_name), 'isActive', coalesce(p_is_active, true)));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_job_title(uuid, text, boolean) from public, anon;
grant execute on function public.save_prosm_time_job_title(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------- the profile
create or replace function public.get_prosm_time_employee_profile(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_access text := public.prosm_time_profile_access(p_user_id);
    v_u users%rowtype;
    v_full boolean;
begin
    if v_access = 'none' then raise exception 'PERMISSION DENIED'; end if;
    v_full := v_access in ('full', 'self');
    select * into v_u from users where id = p_user_id;
    return jsonb_build_object(
        'access', v_access,
        'header', jsonb_build_object(
            'id', v_u.id, 'fullName', v_u.full_name, 'avatarUrl', v_u.avatar_url, 'email', v_u.email,
            'isActive', v_u.is_active, 'isOwner', v_u.is_owner, 'employmentStatus', v_u.employment_status,
            'roleKey', (select role_key from roles where id = v_u.role_id),
            'jobTitleId', v_u.job_title_id, 'jobTitle', (select name from job_titles where id = v_u.job_title_id),
            'siteName', (select name from sites where id = public.prosm_time_calendar_site(v_u.id)),
            'departmentName', (select name from departments where id = v_u.department_id),
            'hireDate', v_u.hire_date,
            'employeeCode', case when v_access in ('full', 'self') then (select employee_code from payroll_profiles where user_id = v_u.id) end,
            'legalName', case when v_access in ('full', 'self') then (select legal_name from payroll_profiles where user_id = v_u.id) end),
        'personal', jsonb_build_object(
            'phone', v_u.phone,
            'emergencyContactName', v_u.emergency_contact_name,
            'emergencyContactPhone', v_u.emergency_contact_phone,
            'nationalId', case when v_full then v_u.national_id end,
            'birthDate', case when v_full then v_u.birth_date end,
            'address', case when v_full then v_u.address end),
        'contracts', case when v_full then coalesce((
            select jsonb_agg(jsonb_build_object('id', c.id, 'type', c.contract_type, 'startDate', c.start_date, 'endDate', c.end_date,
                                                'probationEndDate', c.probation_end_date, 'filePath', c.file_path, 'notes', c.notes) order by c.start_date desc)
            from employee_contracts c where c.user_id = v_u.id), '[]'::jsonb) else null end,
        'canEdit', v_access = 'full'
    );
end;
$$;
revoke all on function public.get_prosm_time_employee_profile(uuid) from public, anon;
grant execute on function public.get_prosm_time_employee_profile(uuid) to authenticated;

create or replace function public.save_prosm_time_employee_hr_data(p_user_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before users%rowtype;
    v_after users%rowtype;
    v_title uuid;
    v_clean text;
begin
    if public.prosm_time_profile_access(p_user_id) <> 'full' then raise exception 'PERMISSION DENIED'; end if;
    select * into v_before from users where id = p_user_id;
    if p_data ? 'job_title_id' then
        v_title := nullif(p_data ->> 'job_title_id', '')::uuid;
        if v_title is not null and not exists (select 1 from job_titles where id = v_title and organization_id = v_org) then raise exception 'JOB TITLE NOT FOUND'; end if;
    end if;
    update users set
        national_id = case when p_data ? 'national_id' then nullif(trim(coalesce(p_data ->> 'national_id', '')), '') else national_id end,
        birth_date = case when p_data ? 'birth_date' then nullif(p_data ->> 'birth_date', '')::date else birth_date end,
        address = case when p_data ? 'address' then nullif(trim(coalesce(p_data ->> 'address', '')), '') else address end,
        phone = case when p_data ? 'phone' then nullif(trim(coalesce(p_data ->> 'phone', '')), '') else phone end,
        emergency_contact_name = case when p_data ? 'emergency_contact_name' then nullif(trim(coalesce(p_data ->> 'emergency_contact_name', '')), '') else emergency_contact_name end,
        emergency_contact_phone = case when p_data ? 'emergency_contact_phone' then nullif(trim(coalesce(p_data ->> 'emergency_contact_phone', '')), '') else emergency_contact_phone end,
        job_title_id = case when p_data ? 'job_title_id' then v_title else job_title_id end,
        employment_status = case when p_data ? 'employment_status' then coalesce(nullif(p_data ->> 'employment_status', ''), employment_status) else employment_status end,
        updated_at = now()
    where id = p_user_id
    returning * into v_after;
    if v_after.birth_date is not null and v_after.birth_date > current_date then raise exception 'THE BIRTH DATE CANNOT BE IN THE FUTURE'; end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'hr.profile_changed', 'users', p_user_id, 'Personnel file changed',
            jsonb_build_object('jobTitleId', v_before.job_title_id, 'employmentStatus', v_before.employment_status, 'phone', v_before.phone),
            jsonb_build_object('jobTitleId', v_after.job_title_id, 'employmentStatus', v_after.employment_status, 'phone', v_after.phone));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.save_prosm_time_employee_hr_data(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_employee_hr_data(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- contracts
create or replace function public.save_prosm_time_employee_contract(p_id uuid, p_user_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
    v_type text := p_data ->> 'type';
    v_start date := nullif(p_data ->> 'start_date', '')::date;
    v_end date := nullif(p_data ->> 'end_date', '')::date;
    v_probation date := nullif(p_data ->> 'probation_end_date', '')::date;
    v_file text := nullif(p_data ->> 'file_path', '');
begin
    if public.prosm_time_profile_access(p_user_id) <> 'full' then raise exception 'PERMISSION DENIED'; end if;
    if v_type not in ('fixed_term', 'open_ended', 'temporary') then raise exception 'CHOOSE THE CONTRACT TYPE'; end if;
    if v_start is null then raise exception 'THE START DATE IS REQUIRED'; end if;
    if v_end is not null and v_end < v_start then raise exception 'THE END DATE IS BEFORE THE START'; end if;
    if v_type in ('fixed_term', 'temporary') and v_end is null then raise exception 'THIS CONTRACT NEEDS AN END DATE'; end if;
    if v_file is not null and split_part(v_file, '/', 1) <> v_org::text then raise exception 'INVALID FILE'; end if;
    if p_id is null then
        insert into employee_contracts (organization_id, user_id, contract_type, start_date, end_date, probation_end_date, file_path, notes, created_by)
        values (v_org, p_user_id, v_type, v_start, v_end, v_probation, v_file, nullif(trim(coalesce(p_data ->> 'notes', '')), ''), public.current_prosm_time_user_id())
        returning id into v_id;
    else
        update employee_contracts set contract_type = v_type, start_date = v_start, end_date = v_end, probation_end_date = v_probation,
            file_path = coalesce(v_file, file_path), notes = nullif(trim(coalesce(p_data ->> 'notes', '')), ''), updated_at = now()
        where id = p_id and user_id = p_user_id and organization_id = v_org returning id into v_id;
        if v_id is null then raise exception 'CONTRACT NOT FOUND'; end if;
    end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'hr.contract_saved', 'employee_contracts', v_id, 'Contract saved',
            jsonb_build_object('type', v_type, 'startDate', v_start, 'endDate', v_end, 'probationEndDate', v_probation));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_employee_contract(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_employee_contract(uuid, uuid, jsonb) to authenticated;

create or replace function public.delete_prosm_time_employee_contract(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row employee_contracts%rowtype;
begin
    select * into v_row from employee_contracts where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_row.id is null then raise exception 'CONTRACT NOT FOUND'; end if;
    if public.prosm_time_profile_access(v_row.user_id) <> 'full' then raise exception 'PERMISSION DENIED'; end if;
    delete from employee_contracts where id = p_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state)
    values (v_row.organization_id, public.current_prosm_time_user_id(), v_row.user_id, 'hr.contract_deleted', 'employee_contracts', p_id, 'Contract deleted', to_jsonb(v_row) - 'organization_id');
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.delete_prosm_time_employee_contract(uuid) from public, anon;
grant execute on function public.delete_prosm_time_employee_contract(uuid) to authenticated;

-- ---------------------------------------------------------------- history (from the action log)
create or replace function public.list_prosm_time_employee_history(p_user_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_access text := public.prosm_time_profile_access(p_user_id);
begin
    if v_access not in ('full', 'manager') then raise exception 'PERMISSION DENIED'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'createdAt', a.created_at, 'reason', a.reason,
                                            'actorName', (select full_name from users where id = a.actor_user_id)) order by a.created_at desc)
        from (
            select * from audit_logs a
            where a.organization_id = public.current_prosm_time_organization_id()
              and (a.subject_user_id = p_user_id or (a.entity_name = 'users' and a.entity_id = p_user_id))
              and (p_before is null or a.created_at < p_before)
              -- a manager does not see pay
              and (v_access = 'full' or a.action !~ '^(payroll|PAY_RATE|payroll_)')
            order by a.created_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200)
        ) a
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_employee_history(uuid, timestamptz, integer) from public, anon;
grant execute on function public.list_prosm_time_employee_history(uuid, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------- attendance and leave at a glance
-- the last p_days days (at most 62): each worked or missed day from the day's own figures (the same
-- rules as timesheets and payroll), and the leave requests of the last year
create or replace function public.get_prosm_time_employee_activity(p_user_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_access text := public.prosm_time_profile_access(p_user_id);
    v_tz text := public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user_id), public.current_prosm_time_organization_id());
    v_today date := (now() at time zone v_tz)::date;
    v_days integer := least(greatest(coalesce(p_days, 30), 1), 62);
    v_rows jsonb := '[]'::jsonb;
    v_day date;
    v_s jsonb;
    v_worked integer := 0;
    v_late integer := 0;
    v_absent integer := 0;
    v_minutes numeric := 0;
begin
    if v_access = 'none' then raise exception 'PERMISSION DENIED'; end if;
    for v_day in select generate_series(v_today - (v_days - 1), v_today, interval '1 day')::date order by 1 desc loop
        v_s := public.prosm_time_day_summary(p_user_id, v_day);
        if coalesce((v_s ->> 'sessions')::integer, 0) > 0 then
            v_worked := v_worked + 1;
            v_minutes := v_minutes + coalesce((v_s ->> 'workedMinutes')::numeric, 0);
            if coalesce((v_s ->> 'lateMinutes')::numeric, 0) > 0 then v_late := v_late + 1; end if;
            v_rows := v_rows || jsonb_build_array(jsonb_build_object('day', v_day, 'state', 'worked', 'firstIn', v_s -> 'firstIn', 'lastOut', v_s -> 'lastOut',
                'workedMinutes', v_s -> 'workedMinutes', 'lateMinutes', v_s -> 'lateMinutes', 'earlyLeaveMinutes', v_s -> 'earlyLeaveMinutes',
                'overtimeMinutes', v_s -> 'overtimeMinutes', 'site', (select name from sites where id = (v_s ->> 'siteId')::uuid)));
        elsif v_day < v_today and public.prosm_time_absent_today(p_user_id, v_day, v_tz) then
            v_absent := v_absent + 1;
            v_rows := v_rows || jsonb_build_array(jsonb_build_object('day', v_day, 'state', 'absent'));
        end if;
    end loop;
    return jsonb_build_object(
        'days', v_days,
        'totals', jsonb_build_object('worked', v_worked, 'late', v_late, 'absent', v_absent, 'workedMinutes', round(v_minutes)),
        'attendance', v_rows,
        'leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'type', l.leave_type, 'startDate', l.start_date, 'endDate', l.end_date,
                                                              'days', l.days_count, 'status', l.status) order by l.start_date desc)
                           from leave_requests l where l.user_id = p_user_id and l.start_date >= v_today - 365), '[]'::jsonb)
    );
end;
$$;
revoke all on function public.get_prosm_time_employee_activity(uuid, integer) from public, anon;
grant execute on function public.get_prosm_time_employee_activity(uuid, integer) to authenticated;

-- ---------------------------------------------------------------- the plans
update public.plans set feature_flags = feature_flags || '{"documents": true, "penalties": true}'::jsonb
where key in ('business', 'pro', 'enterprise', 'legacy');

commit;
