-- 2026-11-11 HR suite, feature 2 (docs/features/PROSM-new-features-spec.md): employee documents and
-- their expiry dates.
--   * document_types: what the company requires - mandatory or optional, with or without an expiry date,
--     reminders N days before (default 30, 7 and the day itself), for everyone / some job titles / some
--     sites, and what an expired one does at clock-in (nothing / warn the managers / block). Ready-made
--     NAME lists per country (Egypt, Gulf) are offered as drafts - no legal value anywhere.
--   * employee_documents: each person's documents. A new person gets a "missing" row for every document
--     that applies to them; an upload waits for review (the personnel managers' own uploads are accepted
--     at once); an accepted renewal archives the old version (replaced_by_id), never deletes it.
--     States: missing, pending_review, valid, expiring, expired, rejected, not_required.
--   * a daily job at 08:00 the company's time: valid -> expiring -> expired, and the reminders on the
--     chosen days to the person and the personnel managers (and, on the expiry day, the person's
--     managers), never twice for the same document, kind and day. The morning summary counts them.
--   * clock-in: a mandatory document set to "block" that has expired stops a self clock-in (a manager
--     can still clock the person in); "warn" lets it through and tells the managers.
-- Who sees: the person (own), the personnel managers (owner / hr.manage). Every change is in the log.
-- Rollback: drop the functions, triggers, the cron job, the three tables and the notification types.

begin;

create table if not exists public.document_types (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (char_length(trim(name)) between 1 and 100),
    is_mandatory boolean not null default true,
    has_expiry boolean not null default true,
    reminder_days integer[] not null default array[30, 7, 0],
    applies_to text not null default 'all' check (applies_to in ('all', 'job_titles', 'sites')),
    job_title_ids uuid[] not null default '{}',
    site_ids uuid[] not null default '{}',
    clock_in_rule text not null default 'none' check (clock_in_rule in ('none', 'warn', 'block')),
    template_key text,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists document_types_org_idx on public.document_types (organization_id) where is_active;
alter table public.document_types enable row level security;
revoke all on public.document_types from public, anon, authenticated;

create table if not exists public.employee_documents (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    document_type_id uuid not null references public.document_types(id) on delete cascade,
    status text not null check (status in ('missing', 'pending_review', 'valid', 'expiring', 'expired', 'rejected', 'not_required')),
    is_current boolean not null default true,
    document_number text check (document_number is null or char_length(document_number) <= 60),
    issue_date date,
    expiry_date date,
    file_path text,
    client_ref uuid unique,
    uploaded_by uuid references public.users(id) on delete set null,
    uploaded_at timestamptz,
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 300),
    replaced_by_id uuid references public.employee_documents(id) on delete set null,
    last_reminded_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (expiry_date is null or issue_date is null or expiry_date >= issue_date)
);
-- one current row per person and type; a pending upload is not current until accepted
create unique index if not exists employee_documents_current_idx on public.employee_documents (user_id, document_type_id) where is_current;
create index if not exists employee_documents_org_idx on public.employee_documents (organization_id, status) where is_current;
alter table public.employee_documents enable row level security;
revoke all on public.employee_documents from public, anon, authenticated;

create table if not exists public.document_reminder_log (
    document_id uuid not null references public.employee_documents(id) on delete cascade,
    kind text not null,
    sent_on date not null,
    primary key (document_id, kind, sent_on)
);
alter table public.document_reminder_log enable row level security;
revoke all on public.document_reminder_log from public, anon, authenticated;

-- ---------------------------------------------------------------- notification types
do $types$
declare
    v_def text;
    v_new text := '''document_missing''::text, ''document_expiring''::text, ''document_expired''::text, ''document_rejected''::text, ''document_reminder''::text, ''document_uploaded''::text, ''document_clock_in''::text';
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('document_missing' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ' || v_new);
        if position('document_missing' in v_def) = 0 then raise exception 'notification type anchor not found'; end if;
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- ---------------------------------------------------------------- rules
-- does this type apply to this person (by job title or site)
create or replace function public.prosm_time_document_applies(p_type document_types, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case p_type.applies_to
        when 'all' then true
        when 'job_titles' then (select job_title_id from users where id = p_user_id) = any(p_type.job_title_ids)
        when 'sites' then exists (select 1 from site_assignments sa where sa.user_id = p_user_id and sa.site_id = any(p_type.site_ids))
                          or public.prosm_time_calendar_site(p_user_id) = any(p_type.site_ids)
        else false end;
$$;
revoke all on function public.prosm_time_document_applies(document_types, uuid) from public, anon, authenticated;

-- the state of an accepted document by its expiry date
create or replace function public.prosm_time_document_state(p_expiry date, p_reminder_days integer[], p_today date)
returns text
language sql
immutable
as $$
    select case
        when p_expiry is null then 'valid'
        when p_expiry < p_today then 'expired'
        when p_expiry - p_today <= coalesce((select max(d) from unnest(p_reminder_days) d), 30) then 'expiring'
        else 'valid' end;
$$;

-- the personnel managers of an organisation (owner + hr.manage)
create or replace function public.prosm_time_hr_people(p_org uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    select u.id from users u
    where u.organization_id = p_org and u.is_active
      and (u.is_owner or public.prosm_time_user_has_permission_internal(u.id, 'hr.manage'));
$$;
revoke all on function public.prosm_time_hr_people(uuid) from public, anon, authenticated;

-- a person's list follows what applies to them: a "missing" row for each document that now applies,
-- and an untouched "missing" row removed when it no longer applies (anything uploaded is kept)
create or replace function public.prosm_time_sync_person_documents(p_user_id uuid, p_notify boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_type document_types%rowtype;
    v_added integer := 0;
    v_doc uuid;
begin
    select organization_id into v_org from users where id = p_user_id and is_active and not is_owner;
    if v_org is null then return 0; end if;
    for v_type in select * from document_types where organization_id = v_org and is_active loop
        if public.prosm_time_document_applies(v_type, p_user_id) then
            if not exists (select 1 from employee_documents where user_id = p_user_id and document_type_id = v_type.id and is_current) then
                insert into employee_documents (organization_id, user_id, document_type_id, status)
                values (v_org, p_user_id, v_type.id, case when v_type.is_mandatory then 'missing' else 'not_required' end)
                returning id into v_doc;
                v_added := v_added + 1;
                if p_notify and v_type.is_mandatory then
                    perform public.create_prosm_time_notification(v_org, p_user_id, 'document_missing', 'normal', 'Document needed',
                        v_type.name || ' is needed in your file.', 'employee_documents', v_doc,
                        jsonb_build_object('documentName', v_type.name, 'documentTypeId', v_type.id, 'kind', 'self'));
                end if;
            end if;
        else
            delete from employee_documents
            where user_id = p_user_id and document_type_id = v_type.id and is_current and status in ('missing', 'not_required') and file_path is null;
        end if;
    end loop;
    delete from employee_documents d using document_types t
    where d.user_id = p_user_id and t.id = d.document_type_id and not t.is_active and d.is_current and d.status in ('missing', 'not_required') and d.file_path is null;
    return v_added;
end;
$$;
revoke all on function public.prosm_time_sync_person_documents(uuid, boolean) from public, anon, authenticated;

-- a new person (or a changed job title) gets their list at once; the personnel managers hear about a newcomer
create or replace function public.prosm_time_documents_follow_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_added integer;
    v_hr uuid;
begin
    if tg_op = 'UPDATE' and new.job_title_id is not distinct from old.job_title_id and new.is_active = old.is_active then return new; end if;
    v_added := public.prosm_time_sync_person_documents(new.id, tg_op = 'INSERT');
    if tg_op = 'INSERT' and v_added > 0 then
        for v_hr in select * from public.prosm_time_hr_people(new.organization_id) loop
            perform public.create_prosm_time_notification(new.organization_id, v_hr, 'document_missing', 'normal', 'New employee documents',
                new.full_name || ' needs ' || v_added || ' document(s).', 'users', new.id,
                jsonb_build_object('employeeName', new.full_name, 'count', v_added, 'kind', 'hr'));
        end loop;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_documents_follow_person() from public, anon, authenticated;
drop trigger if exists users_documents_follow on public.users;
create trigger users_documents_follow after insert or update of job_title_id, is_active on public.users
for each row execute function public.prosm_time_documents_follow_person();

create or replace function public.prosm_time_documents_follow_site()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    perform public.prosm_time_sync_person_documents(coalesce(new.user_id, old.user_id), false);
    return coalesce(new, old);
end;
$$;
revoke all on function public.prosm_time_documents_follow_site() from public, anon, authenticated;
drop trigger if exists site_assignments_documents_follow on public.site_assignments;
create trigger site_assignments_documents_follow after insert or delete on public.site_assignments
for each row execute function public.prosm_time_documents_follow_site();

-- ---------------------------------------------------------------- types (settings)
create or replace function public.list_prosm_time_document_types()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'isMandatory', t.is_mandatory, 'hasExpiry', t.has_expiry,
        'reminderDays', to_jsonb(t.reminder_days), 'appliesTo', t.applies_to, 'jobTitleIds', to_jsonb(t.job_title_ids), 'siteIds', to_jsonb(t.site_ids),
        'clockInRule', t.clock_in_rule, 'templateKey', t.template_key, 'isActive', t.is_active) order by t.is_active desc, t.created_at), '[]'::jsonb)
    from document_types t where t.organization_id = public.current_prosm_time_organization_id();
$$;
revoke all on function public.list_prosm_time_document_types() from public, anon;
grant execute on function public.list_prosm_time_document_types() to authenticated;

create or replace function public.save_prosm_time_document_type(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
    v_days integer[];
    v_applies text := coalesce(p_data ->> 'applies_to', 'all');
    v_person uuid;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_require_feature('documents');
    if nullif(trim(coalesce(p_data ->> 'name', '')), '') is null then raise exception 'A NAME IS REQUIRED'; end if;
    select coalesce(array_agg(distinct d order by d desc), array[]::integer[]) into v_days
    from jsonb_array_elements_text(coalesce(p_data -> 'reminder_days', '[30, 7, 0]'::jsonb)) x(d0) cross join lateral (select d0::integer as d) y
    where d between 0 and 365;
    if v_applies = 'job_titles' and jsonb_array_length(coalesce(p_data -> 'job_title_ids', '[]'::jsonb)) = 0 then raise exception 'CHOOSE AT LEAST ONE JOB TITLE'; end if;
    if v_applies = 'sites' and jsonb_array_length(coalesce(p_data -> 'site_ids', '[]'::jsonb)) = 0 then raise exception 'CHOOSE AT LEAST ONE SITE'; end if;
    if p_id is null then
        insert into document_types (organization_id, name, is_mandatory, has_expiry, reminder_days, applies_to, job_title_ids, site_ids, clock_in_rule, is_active)
        values (v_org, trim(p_data ->> 'name'), coalesce((p_data ->> 'is_mandatory')::boolean, true), coalesce((p_data ->> 'has_expiry')::boolean, true), v_days, v_applies,
                coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_data -> 'job_title_ids') x), '{}'),
                coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_data -> 'site_ids') x), '{}'),
                coalesce(p_data ->> 'clock_in_rule', 'none'), coalesce((p_data ->> 'is_active')::boolean, true))
        returning id into v_id;
    else
        update document_types set name = trim(p_data ->> 'name'),
            is_mandatory = coalesce((p_data ->> 'is_mandatory')::boolean, is_mandatory), has_expiry = coalesce((p_data ->> 'has_expiry')::boolean, has_expiry),
            reminder_days = v_days, applies_to = v_applies,
            job_title_ids = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_data -> 'job_title_ids') x), '{}'),
            site_ids = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_data -> 'site_ids') x), '{}'),
            clock_in_rule = coalesce(p_data ->> 'clock_in_rule', clock_in_rule), is_active = coalesce((p_data ->> 'is_active')::boolean, is_active), updated_at = now()
        where id = p_id and organization_id = v_org returning id into v_id;
        if v_id is null then raise exception 'DOCUMENT TYPE NOT FOUND'; end if;
    end if;
    -- everyone's list follows
    for v_person in select id from users where organization_id = v_org and is_active and not is_owner loop
        perform public.prosm_time_sync_person_documents(v_person, false);
    end loop;
    update employee_documents set status = case when (select is_mandatory from document_types where id = v_id) then 'missing' else 'not_required' end
    where document_type_id = v_id and is_current and status in ('missing', 'not_required') and file_path is null;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.document_type_saved', 'document_types', v_id, 'Document type saved', p_data);
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_document_type(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_document_type(uuid, jsonb) to authenticated;

-- ready-made NAME lists, added as inactive drafts the company reviews and turns on itself
create or replace function public.add_prosm_time_document_templates(p_template text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_names text[];
    v_name text;
    v_added integer := 0;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    v_names := case p_template
        when 'eg' then array['بطاقة الرقم القومي', 'الشهادة الصحية', 'الفيش الجنائي', 'استمارة 1 تأمينات', 'شهادة الخدمة العسكرية', 'عقد العمل', 'رخصة القيادة']
        when 'gulf' then array['الهوية / الإقامة', 'جواز السفر', 'تصريح العمل', 'الشهادة الصحية', 'رخصة القيادة']
        else null end;
    if v_names is null then raise exception 'UNKNOWN TEMPLATE'; end if;
    foreach v_name in array v_names loop
        if not exists (select 1 from document_types where organization_id = v_org and lower(name) = lower(v_name)) then
            insert into document_types (organization_id, name, is_mandatory, has_expiry, template_key, is_active)
            values (v_org, v_name, true, true, p_template, false);
            v_added := v_added + 1;
        end if;
    end loop;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.document_template_added', 'document_types', 'Document names added as drafts', jsonb_build_object('template', p_template, 'added', v_added));
    return jsonb_build_object('success', true, 'added', v_added);
end;
$$;
revoke all on function public.add_prosm_time_document_templates(text) from public, anon;
grant execute on function public.add_prosm_time_document_templates(text) to authenticated;

-- ---------------------------------------------------------------- a person's documents
create or replace function public.list_prosm_time_employee_documents(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_access text := public.prosm_time_profile_access(p_user_id);
    v_today date := (now() at time zone public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user_id), public.current_prosm_time_organization_id()))::date;
begin
    if v_access not in ('full', 'self') then raise exception 'PERMISSION DENIED'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'typeId', t.id, 'typeName', t.name, 'isMandatory', t.is_mandatory, 'hasExpiry', t.has_expiry,
            'status', d.status, 'isCurrent', d.is_current, 'documentNumber', d.document_number, 'issueDate', d.issue_date, 'expiryDate', d.expiry_date,
            'daysLeft', case when d.expiry_date is not null then d.expiry_date - v_today end,
            'hasFile', d.file_path is not null, 'filePath', d.file_path, 'uploadedAt', d.uploaded_at, 'reviewedAt', d.reviewed_at,
            'rejectionReason', d.rejection_reason, 'lastRemindedAt', d.last_reminded_at,
            'pending', (select jsonb_build_object('id', p.id, 'filePath', p.file_path, 'expiryDate', p.expiry_date, 'documentNumber', p.document_number, 'uploadedAt', p.uploaded_at)
                        from employee_documents p where p.user_id = d.user_id and p.document_type_id = d.document_type_id and not p.is_current and p.status = 'pending_review' order by p.created_at desc limit 1),
            'pendingId', (select p.id from employee_documents p where p.user_id = d.user_id and p.document_type_id = d.document_type_id and not p.is_current and p.status = 'pending_review' order by p.created_at desc limit 1),
            'archived', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'documentNumber', a.document_number, 'expiryDate', a.expiry_date, 'filePath', a.file_path, 'status', a.status, 'uploadedAt', a.uploaded_at) order by a.created_at desc)
                                  from employee_documents a where a.user_id = d.user_id and a.document_type_id = d.document_type_id and not a.is_current and a.status <> 'pending_review'), '[]'::jsonb))
            order by t.is_mandatory desc, t.name)
        from employee_documents d join document_types t on t.id = d.document_type_id
        where d.user_id = p_user_id and d.is_current and t.is_active
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_employee_documents(uuid) from public, anon;
grant execute on function public.list_prosm_time_employee_documents(uuid) to authenticated;

-- an upload by the person (waits for review) or by a personnel manager (accepted at once); the
-- phone's offline queue sends client_ref, so a resend is never recorded twice
create or replace function public.submit_prosm_time_document(p_user_id uuid, p_type_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_access text := public.prosm_time_profile_access(p_user_id);
    v_type document_types%rowtype;
    v_ref uuid := nullif(p_data ->> 'client_ref', '')::uuid;
    v_file text := nullif(p_data ->> 'file_path', '');
    v_expiry date := nullif(p_data ->> 'expiry_date', '')::date;
    v_issue date := nullif(p_data ->> 'issue_date', '')::date;
    v_id uuid;
    v_existing uuid;
    v_name text;
    v_hr uuid;
begin
    if v_access not in ('full', 'self') then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_require_feature('documents');
    if v_ref is not null then
        select id into v_existing from employee_documents where client_ref = v_ref;
        if v_existing is not null then return jsonb_build_object('success', true, 'id', v_existing, 'replay', true); end if;
    end if;
    select * into v_type from document_types where id = p_type_id and organization_id = v_org and is_active;
    if v_type.id is null then raise exception 'DOCUMENT TYPE NOT FOUND'; end if;
    if v_file is null then raise exception 'ATTACH THE DOCUMENT'; end if;
    if split_part(v_file, '/', 1) <> v_org::text or split_part(v_file, '/', 2) <> p_user_id::text then raise exception 'INVALID FILE'; end if;
    if v_type.has_expiry and v_expiry is null then raise exception 'THE EXPIRY DATE IS REQUIRED'; end if;
    if v_expiry is not null and v_issue is not null and v_expiry < v_issue then raise exception 'THE EXPIRY DATE IS BEFORE THE ISSUE DATE'; end if;

    insert into employee_documents (organization_id, user_id, document_type_id, status, is_current, document_number, issue_date, expiry_date, file_path, client_ref, uploaded_by, uploaded_at)
    values (v_org, p_user_id, p_type_id, 'pending_review', false, nullif(trim(coalesce(p_data ->> 'document_number', '')), ''), v_issue, v_expiry, v_file, v_ref,
            public.current_prosm_time_user_id(), now())
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'hr.document_uploaded', 'employee_documents', v_id, 'Document uploaded',
            jsonb_build_object('type', v_type.name, 'expiryDate', v_expiry));

    if v_access = 'full' then
        -- the personnel manager's own upload is the review
        perform public.review_prosm_time_document(v_id, true, null);
    else
        select full_name into v_name from users where id = p_user_id;
        for v_hr in select * from public.prosm_time_hr_people(v_org) loop
            perform public.create_prosm_time_notification(v_org, v_hr, 'document_uploaded', 'normal', 'Document to review',
                coalesce(v_name, '') || ' uploaded ' || v_type.name || '.', 'employee_documents', v_id,
                jsonb_build_object('employeeName', v_name, 'documentName', v_type.name, 'userId', p_user_id, 'kind', 'hr'));
        end loop;
    end if;
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.submit_prosm_time_document(uuid, uuid, jsonb) from public, anon;
grant execute on function public.submit_prosm_time_document(uuid, uuid, jsonb) to authenticated;

-- accept (the upload becomes the current version, the old one archived) or reject (with the reason, to the person)
create or replace function public.review_prosm_time_document(p_document_id uuid, p_accept boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_doc employee_documents%rowtype;
    v_type document_types%rowtype;
    v_old uuid;
    v_today date;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    select * into v_doc from employee_documents where id = p_document_id and organization_id = public.current_prosm_time_organization_id();
    if v_doc.id is null then raise exception 'DOCUMENT NOT FOUND'; end if;
    if v_doc.status <> 'pending_review' then raise exception 'THIS DOCUMENT WAS ALREADY REVIEWED'; end if;
    select * into v_type from document_types where id = v_doc.document_type_id;
    v_today := (now() at time zone public.prosm_time_site_timezone(public.prosm_time_calendar_site(v_doc.user_id), v_doc.organization_id))::date;
    if p_accept then
        select id into v_old from employee_documents where user_id = v_doc.user_id and document_type_id = v_doc.document_type_id and is_current;
        update employee_documents set is_current = false, replaced_by_id = p_document_id, updated_at = now() where id = v_old;
        -- an untouched "missing" placeholder is not history: it goes
        delete from employee_documents where id = v_old and file_path is null;
        update employee_documents set is_current = true, status = public.prosm_time_document_state(expiry_date, v_type.reminder_days, v_today),
            reviewed_by = public.current_prosm_time_user_id(), reviewed_at = now(), rejection_reason = null, updated_at = now()
        where id = p_document_id;
    else
        if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'A REASON IS REQUIRED TO REJECT'; end if;
        update employee_documents set status = 'rejected', reviewed_by = public.current_prosm_time_user_id(), reviewed_at = now(),
            rejection_reason = trim(p_reason), updated_at = now() where id = p_document_id;
        perform public.create_prosm_time_notification(v_doc.organization_id, v_doc.user_id, 'document_rejected', 'normal', 'Document not accepted',
            v_type.name || ': ' || trim(p_reason), 'employee_documents', p_document_id,
            jsonb_build_object('documentName', v_type.name, 'reason', trim(p_reason), 'documentTypeId', v_type.id, 'kind', 'self'));
    end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_doc.organization_id, public.current_prosm_time_user_id(), v_doc.user_id,
            case when p_accept then 'hr.document_accepted' else 'hr.document_rejected' end, 'employee_documents', p_document_id,
            case when p_accept then 'Document accepted' else 'Document rejected' end, nullif(trim(coalesce(p_reason, '')), ''));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.review_prosm_time_document(uuid, boolean, text) from public, anon;
grant execute on function public.review_prosm_time_document(uuid, boolean, text) to authenticated;

-- "remind the employee"
create or replace function public.remind_prosm_time_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_doc employee_documents%rowtype;
    v_name text;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    select * into v_doc from employee_documents where id = p_document_id and organization_id = public.current_prosm_time_organization_id();
    if v_doc.id is null then raise exception 'DOCUMENT NOT FOUND'; end if;
    if v_doc.last_reminded_at > now() - interval '1 hour' then raise exception 'ALREADY REMINDED RECENTLY'; end if;
    select name into v_name from document_types where id = v_doc.document_type_id;
    perform public.create_prosm_time_notification(v_doc.organization_id, v_doc.user_id, 'document_reminder', 'normal', 'Document reminder',
        'Please upload ' || v_name || '.', 'employee_documents', p_document_id,
        jsonb_build_object('documentName', v_name, 'status', v_doc.status, 'expiryDate', v_doc.expiry_date, 'documentTypeId', v_doc.document_type_id, 'kind', 'self'));
    update employee_documents set last_reminded_at = now() where id = p_document_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_doc.organization_id, public.current_prosm_time_user_id(), v_doc.user_id, 'hr.document_reminded', 'employee_documents', p_document_id, 'Employee reminded');
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.remind_prosm_time_document(uuid) from public, anon;
grant execute on function public.remind_prosm_time_document(uuid) to authenticated;

-- ---------------------------------------------------------------- the company view (page and widget: the same numbers)
create or replace function public.get_prosm_time_documents_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_today date := (now() at time zone public.prosm_time_site_timezone(null, v_org))::date;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    return (
        with cur as (
            select d.*, t.name as type_name, t.is_mandatory, u.full_name, public.prosm_time_calendar_site(u.id) as site_id
            from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active
            join users u on u.id = d.user_id and u.is_active
            where d.organization_id = v_org and d.is_current
        ),
        pending as (
            select d.*, t.name as type_name, t.is_mandatory, u.full_name, public.prosm_time_calendar_site(u.id) as site_id
            from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active
            join users u on u.id = d.user_id and u.is_active
            where d.organization_id = v_org and not d.is_current and d.status = 'pending_review'
        ),
        mandatory as (select * from cur where is_mandatory),
        people as (select distinct user_id from mandatory),
        complete as (select user_id from mandatory group by user_id having bool_and(status in ('valid', 'expiring')))
        select jsonb_build_object(
            'expired', (select count(*) from cur where status = 'expired'),
            'expiring', (select count(*) from cur where status = 'expiring'),
            'missing', (select count(*) from mandatory where status in ('missing', 'rejected')),
            'pendingReview', (select count(*) from pending),
            'completePercent', case when (select count(*) from people) = 0 then 100 else round(100.0 * (select count(*) from complete) / (select count(*) from people)) end,
            'action', coalesce((select jsonb_agg(x order by x ->> 'rank', x ->> 'daysLeft' nulls first) from (
                select jsonb_build_object('id', c.id, 'userId', c.user_id, 'name', c.full_name, 'site', (select name from sites where id = c.site_id),
                    'typeName', c.type_name, 'status', c.status, 'daysLeft', case when c.expiry_date is not null then c.expiry_date - v_today end,
                    'lastRemindedAt', c.last_reminded_at, 'rank', case c.status when 'expired' then '1' when 'missing' then '2' when 'rejected' then '3' else '4' end) as x
                from cur c where c.status in ('expired', 'expiring') or (c.is_mandatory and c.status in ('missing', 'rejected'))
                union all
                select jsonb_build_object('id', p.id, 'userId', p.user_id, 'name', p.full_name, 'site', (select name from sites where id = p.site_id),
                    'typeName', p.type_name, 'status', 'pending_review', 'daysLeft', null, 'lastRemindedAt', null, 'rank', '0')
                from pending p) s), '[]'::jsonb),
            'all', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'userId', c.user_id, 'name', c.full_name, 'site', (select name from sites where id = c.site_id),
                    'typeName', c.type_name, 'status', c.status, 'expiryDate', c.expiry_date, 'daysLeft', case when c.expiry_date is not null then c.expiry_date - v_today end) order by c.full_name, c.type_name)
                from cur c), '[]'::jsonb)
        )
    );
end;
$$;
revoke all on function public.get_prosm_time_documents_overview() from public, anon;
grant execute on function public.get_prosm_time_documents_overview() to authenticated;

-- ---------------------------------------------------------------- the profile's completeness bar
create or replace function public.prosm_time_document_completion(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select case when count(*) = 0 then null else jsonb_build_object(
        'percent', round(100.0 * count(*) filter (where d.status in ('valid', 'expiring')) / count(*)),
        'missing', count(*) filter (where d.status not in ('valid', 'expiring'))) end
    from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active and t.is_mandatory
    where d.user_id = p_user_id and d.is_current;
$$;
revoke all on function public.prosm_time_document_completion(uuid) from public, anon, authenticated;

do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.get_prosm_time_employee_profile(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    a text := '''canEdit'', v_access = ''full''';
begin
    if position(a in v_def) = 0 then raise exception 'profile anchor not found'; end if;
    v_def := replace(v_def, a, a || ',
        ''completion'', case when v_access in (''full'', ''self'') and public.prosm_time_plan_allows(v_u.organization_id, ''documents'') then public.prosm_time_document_completion(v_u.id) end');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- the daily job
create or replace function public.process_prosm_time_document_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org record;
    v_doc record;
    v_today date;
    v_state text;
    v_days integer;
    v_kind text;
    v_sent integer := 0;
    v_to uuid;
begin
    for v_org in
        select o.id, public.prosm_time_site_timezone(null, o.id) as tz from organizations o
        where not public.prosm_time_org_locked(o.id) and public.prosm_time_plan_allows(o.id, 'documents')
          and exists (select 1 from document_types t where t.organization_id = o.id and t.is_active)
    loop
        continue when extract(hour from (now() at time zone v_org.tz)) <> 8;
        v_today := (now() at time zone v_org.tz)::date;
        for v_doc in
            select d.*, t.name as type_name, t.reminder_days, u.full_name
            from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active and t.has_expiry
            join users u on u.id = d.user_id and u.is_active
            where d.organization_id = v_org.id and d.is_current and d.status in ('valid', 'expiring', 'expired') and d.expiry_date is not null
        loop
            v_state := public.prosm_time_document_state(v_doc.expiry_date, v_doc.reminder_days, v_today);
            if v_state <> v_doc.status then update employee_documents set status = v_state, updated_at = now() where id = v_doc.id; end if;
            v_days := v_doc.expiry_date - v_today;
            v_kind := case when v_days < 0 then null when v_days = 0 then 'expired' when v_days = any(v_doc.reminder_days) then 'expiring_' || v_days else null end;
            continue when v_kind is null;
            -- once per document, kind and day
            insert into document_reminder_log (document_id, kind, sent_on) values (v_doc.id, v_kind, v_today) on conflict do nothing;
            continue when not found;
            perform public.create_prosm_time_notification(v_org.id, v_doc.user_id, case when v_days = 0 then 'document_expired' else 'document_expiring' end, 'normal',
                v_doc.type_name, v_doc.type_name || case when v_days = 0 then ' expires today.' else ' expires in ' || v_days || ' days.' end,
                'employee_documents', v_doc.id, jsonb_build_object('documentName', v_doc.type_name, 'days', v_days, 'documentTypeId', v_doc.document_type_id, 'kind', 'self'));
            for v_to in
                select * from public.prosm_time_hr_people(v_org.id)
                union
                -- on the expiry day the person's managers too
                select sa.user_id from site_assignments sa
                where v_days = 0 and sa.role_at_site = 'manager'
                  and sa.site_id in (select x.site_id from site_assignments x where x.user_id = v_doc.user_id)
            loop
                continue when v_to = v_doc.user_id;
                perform public.create_prosm_time_notification(v_org.id, v_to, case when v_days = 0 then 'document_expired' else 'document_expiring' end, 'normal',
                    v_doc.type_name, v_doc.full_name || ': ' || v_doc.type_name || case when v_days = 0 then ' expires today.' else ' expires in ' || v_days || ' days.' end,
                    'employee_documents', v_doc.id, jsonb_build_object('documentName', v_doc.type_name, 'days', v_days, 'employeeName', v_doc.full_name, 'userId', v_doc.user_id, 'kind', 'hr'));
            end loop;
            v_sent := v_sent + 1;
        end loop;
    end loop;
    delete from document_reminder_log where sent_on < current_date - 60;
    return jsonb_build_object('sent', v_sent);
end;
$$;
revoke all on function public.process_prosm_time_document_reminders() from public, anon, authenticated;
select cron.schedule('prosm-time-document-reminders', '5 * * * *', $$select public.process_prosm_time_document_reminders();$$);

-- ---------------------------------------------------------------- the morning summary counts them
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.process_prosm_time_manager_alerts()'::regprocedure), chr(13) || chr(10), chr(10));
    a text := '''late'', v_late, ''onLeave'', v_on_leave,';
begin
    if position(a in v_def) = 0 then raise exception 'digest documents anchor not found'; end if;
    v_def := replace(v_def, a, a || ' ''documentsExpired'', (select count(*) from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active
                            where d.organization_id = v_row.organization_id and d.is_current and d.status = ''expired''),
                        ''documentsMissing'', (select count(*) from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active and t.is_mandatory
                            where d.organization_id = v_row.organization_id and d.is_current and d.status in (''missing'', ''rejected'')),');
    execute v_def;
end;
$patch$;

-- ---------------------------------------------------------------- clock-in: an expired document set to warn / block
create or replace function public.prosm_time_document_clock_in_check(p_user_id uuid, p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_block text;
    v_warn text;
    v_name text;
    v_to uuid;
begin
    if not public.prosm_time_plan_allows(p_org, 'documents') then return null; end if;
    select string_agg(t.name, ', ') filter (where t.clock_in_rule = 'block'), string_agg(t.name, ', ') filter (where t.clock_in_rule = 'warn')
    into v_block, v_warn
    from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active and t.is_mandatory
    where d.user_id = p_user_id and d.is_current and (d.status = 'expired' or (d.status in ('missing', 'rejected') and t.clock_in_rule = 'block'));
    if v_block is not null then raise exception 'DOCUMENT REQUIRED TO CLOCK IN: %', v_block; end if;
    if v_warn is not null then
        select full_name into v_name from users where id = p_user_id;
        for v_to in select * from public.prosm_time_hr_people(p_org) loop
            perform public.create_prosm_time_notification(p_org, v_to, 'document_clock_in', 'high', 'Clocked in with an expired document',
                coalesce(v_name, '') || ' clocked in with an expired document: ' || v_warn || '.', 'users', p_user_id,
                jsonb_build_object('employeeName', v_name, 'documentName', v_warn, 'userId', p_user_id, 'kind', 'hr'));
        end loop;
    end if;
    return v_warn;
end;
$$;
revoke all on function public.prosm_time_document_clock_in_check(uuid, uuid) from public, anon, authenticated;

do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.clock_in_prosm_time_attendance(text,uuid,uuid,timestamp with time zone,double precision,double precision,double precision,text,text,text,boolean,boolean)'::regprocedure), chr(13) || chr(10), chr(10));
    a text := '    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)';
begin
    if position(a in v_def) = 0 then raise exception 'clock-in documents anchor not found'; end if;
    v_def := replace(v_def, a, '    -- 2026-11-11 HR suite: an expired (or, when set to block, missing) mandatory document
    perform public.prosm_time_document_clock_in_check(v_caller_id, v_caller_org);
' || a);
    execute v_def;
end;
$patch$;

-- everyone already in a company with document types gets their list (none exist yet; kept for re-runs)
do $sync$
declare
    v_user uuid;
begin
    for v_user in select distinct u.id from users u join document_types t on t.organization_id = u.organization_id where u.is_active and not u.is_owner loop
        perform public.prosm_time_sync_person_documents(v_user, false);
    end loop;
end;
$sync$;

commit;
