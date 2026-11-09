-- 2026-11-09 (owner): the Media Center for PROSM Time.
--
-- Departments: an organisation's own list; a person belongs to at most one (chosen when they are
-- added and on their page). Used to address announcements.
--
-- Announcements and official statements: a title, text, links and files (images, PDF, Office -
-- no video upload; videos are shared as links), addressed to the whole organisation, sites,
-- departments or chosen people; published now or at a set time, and expiring at a set time;
-- every recipient is notified in the app and by phone, and by email when the publisher chooses
-- "publish with email"; who has opened and who has confirmed reading is tracked.
--
-- Files live in PROSM Platform's external media service, in its PRIVATE bucket, isolated by
-- product and licence; Time keeps only the reference and hands a reader a short-lived link after
-- checking here that they are a recipient (edge function announcement-media). Nothing of
-- Platform is exposed to a Time user, and no Time user gets any authority on Platform.
--
-- Isolation: every row carries organization_id; no table is readable by a client directly -
-- everything goes through the functions below, which check the organisation, the permission and,
-- for anyone who is not organisation-wide, the sites and people under their authority.
--
-- Permissions: announcements.publish (managers by default: to the sites they manage and the
-- people under them), announcements.manage (organisation-wide: any audience, edit and withdraw
-- any announcement), announcements.view_reads (who read; managers by default, within their
-- authority), departments.manage. The owner holds them all.
--
-- Rollback: drop the functions, tables announcement_recipients, announcement_attachments,
-- announcements, the users.department_id column and departments; remove the notification type,
-- the permissions and the cron jobs.

begin;

-- ---------------------------------------------------------------- departments
create table public.departments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 120),
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index departments_org_name_idx on public.departments (organization_id, lower(trim(name)));
alter table public.departments enable row level security;
revoke all on public.departments from public, anon, authenticated;

alter table public.users add column if not exists department_id uuid references public.departments(id) on delete set null;
create index if not exists users_department_idx on public.users (department_id) where department_id is not null;

-- ---------------------------------------------------------------- announcements
create table public.announcements (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    kind text not null default 'announcement' check (kind in ('announcement', 'statement')),
    title text not null check (length(trim(title)) between 1 and 200),
    body text not null default '' check (length(body) <= 20000),
    status text not null default 'draft' check (status in ('draft', 'scheduled', 'published', 'expired', 'withdrawn')),
    audience_type text not null default 'all' check (audience_type in ('all', 'sites', 'departments', 'people')),
    audience_ids uuid[] not null default '{}',
    requires_ack boolean not null default false,
    send_email boolean not null default false,
    publish_at timestamptz,
    expires_at timestamptz,
    published_at timestamptz,
    withdrawn_at timestamptz,
    withdrawn_reason text,
    created_by uuid references public.users(id) on delete set null,
    updated_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint announcements_audience_shape check (audience_type = 'all' or cardinality(audience_ids) > 0),
    constraint announcements_expiry_after_publish check (expires_at is null or publish_at is null or expires_at > publish_at)
);
create index announcements_org_idx on public.announcements (organization_id, status);
create index announcements_due_idx on public.announcements (publish_at) where status = 'scheduled';
create index announcements_expiry_idx on public.announcements (expires_at) where status = 'published' and expires_at is not null;

create table public.announcement_attachments (
    id uuid primary key default gen_random_uuid(),
    announcement_id uuid not null references public.announcements(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    kind text not null check (kind in ('link', 'file')),
    title text not null check (length(trim(title)) between 1 and 300),
    url text check (url is null or (url ~* '^https?://' and length(url) <= 2000)),
    asset_id uuid,
    file_name text,
    mime_type text,
    file_size bigint,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint announcement_attachments_shape check (
        (kind = 'link' and url is not null and asset_id is null)
        or (kind = 'file' and asset_id is not null and file_name is not null and url is null)
    )
);
create index announcement_attachments_ann_idx on public.announcement_attachments (announcement_id);

create table public.announcement_recipients (
    announcement_id uuid not null references public.announcements(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    delivered_at timestamptz not null default now(),
    viewed_at timestamptz,
    acknowledged_at timestamptz,
    email_status text not null default 'none' check (email_status in ('none', 'pending', 'sending', 'sent', 'failed')),
    email_attempts integer not null default 0,
    email_error text,
    email_next_at timestamptz,
    primary key (announcement_id, user_id)
);
create index announcement_recipients_user_idx on public.announcement_recipients (user_id);
create index announcement_recipients_email_idx on public.announcement_recipients (email_next_at) where email_status = 'pending';

alter table public.announcements enable row level security;
alter table public.announcement_attachments enable row level security;
alter table public.announcement_recipients enable row level security;
revoke all on public.announcements, public.announcement_attachments, public.announcement_recipients from public, anon, authenticated;

-- ---------------------------------------------------------------- permissions
insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('announcements.publish', 'announcements', 'CREATE', 'Publish announcements', 'Write and publish announcements to the sites one manages and the people under one''s authority.'),
    ('announcements.manage', 'announcements', 'ADMINISTER', 'Manage all announcements', 'Address the whole organisation or departments; edit and withdraw any announcement.'),
    ('announcements.view_reads', 'announcements', 'VIEW', 'See who read announcements', 'See who opened and who confirmed reading, within one''s authority.'),
    ('departments.manage', 'departments', 'ADMINISTER', 'Manage departments', 'Add, rename and archive departments.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
where (r.role_key = 'owner' and p.permission_key in ('announcements.publish', 'announcements.manage', 'announcements.view_reads', 'departments.manage'))
   or (r.role_key = 'manager' and p.permission_key in ('announcements.publish', 'announcements.view_reads'))
on conflict (role_id, permission_id) do nothing;

-- ---------------------------------------------------------------- notification type
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('announcement_published' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''announcement_published''::text');
        if position('announcement_published' in v_def) = 0 then raise exception 'notification type anchor not found'; end if;
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- ---------------------------------------------------------------- helpers
-- organisation-wide for announcements: the owner, a full delegate, or announcements.manage
create or replace function public.prosm_time_announcements_org_wide(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_user_has_permission_internal(p_user_id, 'announcements.manage');
$$;
revoke all on function public.prosm_time_announcements_org_wide(uuid) from public, anon, authenticated;

-- the people an announcement is addressed to, now (active members of its organisation)
create or replace function public.prosm_time_announcement_audience(p_announcement_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    select u.id
    from announcements a
    join users u on u.organization_id = a.organization_id and u.is_active
    where a.id = p_announcement_id
      and (
          a.audience_type = 'all'
          or (a.audience_type = 'people' and u.id = any(a.audience_ids))
          or (a.audience_type = 'departments' and u.department_id = any(a.audience_ids))
          or (a.audience_type = 'sites' and exists (
                select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(a.audience_ids)))
      );
$$;
revoke all on function public.prosm_time_announcement_audience(uuid) from public, anon, authenticated;

-- checks that the caller may address this audience; raises otherwise
create or replace function public.prosm_time_check_announcement_audience(p_user_id uuid, p_org uuid, p_type text, p_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_wide boolean := public.prosm_time_announcements_org_wide(p_user_id);
    v_id uuid;
begin
    if p_type not in ('all', 'sites', 'departments', 'people') then raise exception 'INVALID AUDIENCE'; end if;
    if p_type <> 'all' and coalesce(cardinality(p_ids), 0) = 0 then raise exception 'CHOOSE AT LEAST ONE RECIPIENT GROUP'; end if;
    if p_type = 'all' or p_type = 'departments' then
        if not v_wide then raise exception 'ONLY ORGANISATION-WIDE PUBLISHERS MAY ADDRESS THIS AUDIENCE'; end if;
    end if;
    if p_type = 'sites' then
        foreach v_id in array p_ids loop
            if not exists (select 1 from sites where id = v_id and organization_id = p_org) then raise exception 'SITE NOT FOUND'; end if;
            if not v_wide and not exists (select 1 from site_assignments where site_id = v_id and user_id = p_user_id and role_at_site = 'manager') then
                raise exception 'YOU CAN ONLY ADDRESS THE SITES YOU MANAGE';
            end if;
        end loop;
    elsif p_type = 'departments' then
        foreach v_id in array p_ids loop
            if not exists (select 1 from departments where id = v_id and organization_id = p_org) then raise exception 'DEPARTMENT NOT FOUND'; end if;
        end loop;
    elsif p_type = 'people' then
        foreach v_id in array p_ids loop
            if not exists (select 1 from users where id = v_id and organization_id = p_org) then raise exception 'EMPLOYEE NOT FOUND'; end if;
            if not v_wide and v_id <> p_user_id and not exists (
                select 1 from site_assignments mine join site_assignments theirs on theirs.site_id = mine.site_id
                where mine.user_id = p_user_id and mine.role_at_site = 'manager' and theirs.user_id = v_id
            ) then
                raise exception 'YOU CAN ONLY ADDRESS PEOPLE AT THE SITES YOU MANAGE';
            end if;
        end loop;
    end if;
end;
$$;
revoke all on function public.prosm_time_check_announcement_audience(uuid, uuid, text, uuid[]) from public, anon, authenticated;

-- may the caller edit / withdraw this announcement
create or replace function public.prosm_time_can_edit_announcement(p_user_id uuid, p_announcement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from announcements a join users u on u.id = p_user_id and u.organization_id = a.organization_id
        where a.id = p_announcement_id
          and (
              public.prosm_time_announcements_org_wide(p_user_id)
              or (a.created_by = p_user_id and public.prosm_time_user_has_permission_internal(p_user_id, 'announcements.publish'))
          )
    );
$$;
revoke all on function public.prosm_time_can_edit_announcement(uuid, uuid) from public, anon, authenticated;

-- publishes now: recipients fixed at this moment, notified, emails queued
create or replace function public.prosm_time_publish_announcement_now(p_announcement_id uuid, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_a announcements%rowtype;
    v_count integer;
begin
    select * into v_a from announcements where id = p_announcement_id for update;
    if v_a.id is null or v_a.status not in ('draft', 'scheduled') then return 0; end if;
    update announcements set status = 'published', published_at = now(), publish_at = coalesce(publish_at, now()), updated_at = now()
    where id = p_announcement_id;

    insert into announcement_recipients (announcement_id, user_id, organization_id, email_status, email_next_at)
    select p_announcement_id, r.id, v_a.organization_id,
           case when v_a.send_email and coalesce(u.email, '') like '%@%' then 'pending' else 'none' end,
           case when v_a.send_email then now() end
    from public.prosm_time_announcement_audience(p_announcement_id) r(id)
    join users u on u.id = r.id
    on conflict do nothing;
    get diagnostics v_count = row_count;

    -- no text of the announcement in the notification itself: the title only, the app shows the rest
    insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
    select v_a.organization_id, ar.user_id, 'announcement_published', case when v_a.kind = 'statement' then 'high' else 'normal' end,
           'New announcement', v_a.title, 'announcements', p_announcement_id,
           jsonb_build_object('kind', v_a.kind, 'requiresAck', v_a.requires_ack, 'title', v_a.title)
    from announcement_recipients ar
    where ar.announcement_id = p_announcement_id and ar.user_id is distinct from p_actor;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_a.organization_id, p_actor, 'ANNOUNCEMENT_PUBLISHED', 'announcements', p_announcement_id, 'Published an announcement',
            jsonb_build_object('title', v_a.title, 'audience', v_a.audience_type, 'recipients', v_count, 'email', v_a.send_email));
    return v_count;
end;
$$;
revoke all on function public.prosm_time_publish_announcement_now(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- departments API
create or replace function public.list_prosm_time_departments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'isActive', d.is_active,
            'members', (select count(*) from users u where u.department_id = d.id and u.is_active)) order by d.is_active desc, lower(d.name))
        from departments d where d.organization_id = v_org
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_departments() from public, anon;
grant execute on function public.list_prosm_time_departments() to authenticated;

create or replace function public.save_prosm_time_department(p_id uuid, p_name text, p_is_active boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_name text := trim(coalesce(p_name, ''));
    v_id uuid := p_id;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_me, 'departments.manage') then raise exception 'NOT ALLOWED TO MANAGE DEPARTMENTS'; end if;
    if length(v_name) = 0 or length(v_name) > 120 then raise exception 'A DEPARTMENT NAME IS REQUIRED'; end if;
    if exists (select 1 from departments where organization_id = v_org and lower(trim(name)) = lower(v_name) and id is distinct from p_id) then
        raise exception 'A DEPARTMENT WITH THIS NAME ALREADY EXISTS';
    end if;
    if p_id is null then
        insert into departments (organization_id, name) values (v_org, v_name) returning id into v_id;
    else
        update departments set name = v_name, is_active = coalesce(p_is_active, true), updated_at = now()
        where id = p_id and organization_id = v_org;
        if not found then raise exception 'DEPARTMENT NOT FOUND'; end if;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_me, case when p_id is null then 'DEPARTMENT_CREATED' else 'DEPARTMENT_UPDATED' end, 'departments', v_id,
            'Saved a department', jsonb_build_object('name', v_name, 'isActive', coalesce(p_is_active, true)));
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_department(uuid, text, boolean) from public, anon;
grant execute on function public.save_prosm_time_department(uuid, text, boolean) to authenticated;

create or replace function public.get_prosm_time_user_department(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_row record;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_user_id <> v_me and not public.prosm_time_caller_sees_person(p_user_id) then raise exception 'EMPLOYEE NOT FOUND'; end if;
    select d.id, d.name into v_row from users u left join departments d on d.id = u.department_id
    where u.id = p_user_id and u.organization_id = public.current_prosm_time_organization_id();
    return jsonb_build_object('departmentId', v_row.id, 'name', v_row.name);
end;
$$;
revoke all on function public.get_prosm_time_user_department(uuid) from public, anon;
grant execute on function public.get_prosm_time_user_department(uuid) to authenticated;

create or replace function public.set_prosm_time_user_department(p_user_id uuid, p_department_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_from uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_me, 'employees.edit') then raise exception 'NOT ALLOWED TO EDIT EMPLOYEES'; end if;
    select department_id into v_from from users where id = p_user_id and organization_id = v_org for update;
    if not found then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if not public.current_prosm_time_user_is_owner() and not public.prosm_time_caller_has_authority_over(p_user_id) then
        raise exception 'YOU HAVE NO AUTHORITY OVER THIS PERSON';
    end if;
    if p_department_id is not null and not exists (select 1 from departments where id = p_department_id and organization_id = v_org and is_active) then
        raise exception 'DEPARTMENT NOT FOUND';
    end if;
    update users set department_id = p_department_id, updated_at = now() where id = p_user_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_me, p_user_id, 'USER_DEPARTMENT_CHANGED', 'users', p_user_id, 'Changed a person''s department',
            jsonb_build_object('departmentId', v_from), jsonb_build_object('departmentId', p_department_id));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_user_department(uuid, uuid) from public, anon;
grant execute on function public.set_prosm_time_user_department(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- announcements API (publisher)
create or replace function public.save_prosm_time_announcement(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_title text := trim(coalesce(p_data ->> 'title', ''));
    v_body text := coalesce(p_data ->> 'body', '');
    v_kind text := coalesce(p_data ->> 'kind', 'announcement');
    v_type text := coalesce(p_data ->> 'audienceType', 'all');
    v_ids uuid[] := coalesce((select array_agg(distinct x::uuid) from jsonb_array_elements_text(coalesce(p_data -> 'audienceIds', '[]'::jsonb)) x), '{}');
    v_expires timestamptz := nullif(p_data ->> 'expiresAt', '')::timestamptz;
    v_id uuid := p_id;
    v_status text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_me, 'announcements.publish')
       and not public.prosm_time_announcements_org_wide(v_me) then
        raise exception 'NOT ALLOWED TO PUBLISH ANNOUNCEMENTS';
    end if;
    if length(v_title) = 0 or length(v_title) > 200 then raise exception 'A TITLE IS REQUIRED'; end if;
    if length(v_body) > 20000 then raise exception 'THE TEXT IS TOO LONG'; end if;
    if v_kind not in ('announcement', 'statement') then raise exception 'INVALID KIND'; end if;
    if v_type = 'all' then v_ids := '{}'; end if;
    perform public.prosm_time_check_announcement_audience(v_me, v_org, v_type, v_ids);
    if v_expires is not null and v_expires <= now() then raise exception 'THE EXPIRY MUST BE IN THE FUTURE'; end if;

    if p_id is null then
        insert into announcements (organization_id, kind, title, body, audience_type, audience_ids, requires_ack, send_email, expires_at, created_by, updated_by)
        values (v_org, v_kind, v_title, v_body, v_type, v_ids, coalesce((p_data ->> 'requiresAck')::boolean, false),
                coalesce((p_data ->> 'sendEmail')::boolean, false), v_expires, v_me, v_me)
        returning id into v_id;
    else
        select status into v_status from announcements where id = p_id and organization_id = v_org for update;
        if v_status is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
        if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
        if v_status not in ('draft', 'scheduled') then raise exception 'A PUBLISHED ANNOUNCEMENT CANNOT BE EDITED'; end if;
        update announcements set kind = v_kind, title = v_title, body = v_body, audience_type = v_type, audience_ids = v_ids,
               requires_ack = coalesce((p_data ->> 'requiresAck')::boolean, false), send_email = coalesce((p_data ->> 'sendEmail')::boolean, false),
               expires_at = v_expires, updated_by = v_me, updated_at = now()
        where id = p_id;
    end if;
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_announcement(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_announcement(uuid, jsonb) to authenticated;

-- now (p_publish_at null or past) or at a set time; the audience is checked again
create or replace function public.publish_prosm_time_announcement(p_id uuid, p_publish_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_a announcements%rowtype;
    v_count integer;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_a from announcements where id = p_id and organization_id = v_org for update;
    if v_a.id is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    if v_a.status not in ('draft', 'scheduled') then raise exception 'THIS ANNOUNCEMENT IS ALREADY PUBLISHED'; end if;
    perform public.prosm_time_check_announcement_audience(v_me, v_org, v_a.audience_type, v_a.audience_ids);
    if v_a.expires_at is not null and v_a.expires_at <= greatest(now(), coalesce(p_publish_at, now())) then
        raise exception 'THE EXPIRY MUST BE AFTER THE PUBLISHING TIME';
    end if;
    if p_publish_at is not null and p_publish_at > now() + interval '30 seconds' then
        update announcements set status = 'scheduled', publish_at = p_publish_at, updated_by = v_me, updated_at = now() where id = p_id;
        insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
        values (v_org, v_me, 'ANNOUNCEMENT_SCHEDULED', 'announcements', p_id, 'Scheduled an announcement', jsonb_build_object('publishAt', p_publish_at));
        return jsonb_build_object('status', 'scheduled', 'publishAt', p_publish_at);
    end if;
    update announcements set publish_at = null where id = p_id;
    v_count := public.prosm_time_publish_announcement_now(p_id, v_me);
    return jsonb_build_object('status', 'published', 'recipients', v_count);
end;
$$;
revoke all on function public.publish_prosm_time_announcement(uuid, timestamptz) from public, anon;
grant execute on function public.publish_prosm_time_announcement(uuid, timestamptz) to authenticated;

-- back to draft (a scheduled one), or withdrawn (a published one, with a reason): recipients stop seeing it
create or replace function public.withdraw_prosm_time_announcement(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_status text;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select status into v_status from announcements where id = p_id and organization_id = v_org for update;
    if v_status is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    if v_status = 'scheduled' then
        update announcements set status = 'draft', publish_at = null, updated_by = v_me, updated_at = now() where id = p_id;
        return jsonb_build_object('status', 'draft');
    end if;
    if v_status not in ('published', 'expired') then raise exception 'ONLY A PUBLISHED ANNOUNCEMENT CAN BE WITHDRAWN'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    update announcements set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = v_reason, updated_by = v_me, updated_at = now() where id = p_id;
    -- emails not yet sent are not sent
    update announcement_recipients set email_status = 'none' where announcement_id = p_id and email_status = 'pending';
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, reason)
    values (v_org, v_me, 'ANNOUNCEMENT_WITHDRAWN', 'announcements', p_id, 'Withdrew an announcement', v_reason);
    return jsonb_build_object('status', 'withdrawn');
end;
$$;
revoke all on function public.withdraw_prosm_time_announcement(uuid, text) from public, anon;
grant execute on function public.withdraw_prosm_time_announcement(uuid, text) to authenticated;

-- a draft only; returns the stored files so the caller removes them from the media service
create or replace function public.delete_prosm_time_announcement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_status text;
    v_files jsonb;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select status into v_status from announcements where id = p_id and organization_id = v_org for update;
    if v_status is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    if v_status <> 'draft' then raise exception 'ONLY A DRAFT CAN BE DELETED'; end if;
    if exists (select 1 from announcement_attachments where announcement_id = p_id and kind = 'file') then
        raise exception 'REMOVE THE FILES FIRST';
    end if;
    delete from announcements where id = p_id;
    return jsonb_build_object('deleted', true);
end;
$$;
revoke all on function public.delete_prosm_time_announcement(uuid) from public, anon;
grant execute on function public.delete_prosm_time_announcement(uuid) to authenticated;

create or replace function public.add_prosm_time_announcement_link(p_id uuid, p_url text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_status text;
    v_url text := trim(coalesce(p_url, ''));
    v_new uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select status into v_status from announcements where id = p_id and organization_id = v_org;
    if v_status is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    if v_status not in ('draft', 'scheduled') then raise exception 'A PUBLISHED ANNOUNCEMENT CANNOT BE EDITED'; end if;
    if v_url !~* '^https?://[^\s/$.?#][^\s]*$' or length(v_url) > 2000 then raise exception 'ENTER A FULL WEB ADDRESS'; end if;
    if (select count(*) from announcement_attachments where announcement_id = p_id) >= 20 then raise exception 'AT MOST 20 ATTACHMENTS'; end if;
    insert into announcement_attachments (announcement_id, organization_id, kind, title, url, created_by)
    values (p_id, v_org, 'link', coalesce(nullif(trim(coalesce(p_title, '')), ''), v_url), v_url, v_me)
    returning id into v_new;
    return jsonb_build_object('id', v_new);
end;
$$;
revoke all on function public.add_prosm_time_announcement_link(uuid, text, text) from public, anon;
grant execute on function public.add_prosm_time_announcement_link(uuid, text, text) to authenticated;

-- removes one attachment; for a file, returns its media id so the edge function deletes the stored copy
create or replace function public.remove_prosm_time_announcement_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_att announcement_attachments%rowtype;
    v_status text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_att from announcement_attachments where id = p_attachment_id and organization_id = public.current_prosm_time_organization_id();
    if v_att.id is null then raise exception 'ATTACHMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, v_att.announcement_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    select status into v_status from announcements where id = v_att.announcement_id;
    if v_status not in ('draft', 'scheduled') then raise exception 'A PUBLISHED ANNOUNCEMENT CANNOT BE EDITED'; end if;
    delete from announcement_attachments where id = p_attachment_id;
    return jsonb_build_object('kind', v_att.kind, 'assetId', v_att.asset_id, 'organizationId', v_att.organization_id);
end;
$$;
revoke all on function public.remove_prosm_time_announcement_attachment(uuid) from public, anon;
grant execute on function public.remove_prosm_time_announcement_attachment(uuid) to authenticated;

-- for the edge function, with the caller's session: may they add a file to this announcement
create or replace function public.prosm_time_announcement_upload_check(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_status text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select status into v_status from announcements where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_status is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    if v_status not in ('draft', 'scheduled') then raise exception 'A PUBLISHED ANNOUNCEMENT CANNOT BE EDITED'; end if;
    if (select count(*) from announcement_attachments where announcement_id = p_id) >= 20 then raise exception 'AT MOST 20 ATTACHMENTS'; end if;
    return jsonb_build_object('ok', true, 'userId', v_me, 'organizationId', public.current_prosm_time_organization_id());
end;
$$;
revoke all on function public.prosm_time_announcement_upload_check(uuid) from public, anon;
grant execute on function public.prosm_time_announcement_upload_check(uuid) to authenticated;

-- service role only (edge function after the upload): records the stored file
create or replace function public.prosm_time_announcement_attach_file(p_id uuid, p_actor uuid, p_asset_id uuid, p_file_name text, p_mime text, p_size bigint, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_new uuid;
begin
    select organization_id into v_org from announcements where id = p_id and status in ('draft', 'scheduled');
    if v_org is null then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    if not public.prosm_time_can_edit_announcement(p_actor, p_id) then raise exception 'NOT ALLOWED TO EDIT THIS ANNOUNCEMENT'; end if;
    insert into announcement_attachments (announcement_id, organization_id, kind, title, asset_id, file_name, mime_type, file_size, created_by)
    values (p_id, v_org, 'file', coalesce(nullif(trim(coalesce(p_title, '')), ''), p_file_name), p_asset_id, p_file_name, p_mime, p_size, p_actor)
    returning id into v_new;
    return jsonb_build_object('id', v_new);
end;
$$;
revoke all on function public.prosm_time_announcement_attach_file(uuid, uuid, uuid, text, text, bigint, text) from public, anon, authenticated;

-- for the edge function, with the caller's session: the media id of a file the caller may open now
-- (a recipient of a published, unexpired announcement; or whoever may edit it)
create or replace function public.prosm_time_announcement_file_for_reader(p_attachment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_att announcement_attachments%rowtype;
    v_a announcements%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_att from announcement_attachments where id = p_attachment_id and organization_id = public.current_prosm_time_organization_id() and kind = 'file';
    if v_att.id is null then raise exception 'ATTACHMENT NOT FOUND'; end if;
    select * into v_a from announcements where id = v_att.announcement_id;
    if not public.prosm_time_can_edit_announcement(v_me, v_a.id) and not (
        v_a.status = 'published' and (v_a.expires_at is null or v_a.expires_at > now())
        and exists (select 1 from announcement_recipients where announcement_id = v_a.id and user_id = v_me)
    ) then
        raise exception 'ATTACHMENT NOT FOUND';
    end if;
    return jsonb_build_object('assetId', v_att.asset_id, 'fileName', v_att.file_name, 'mimeType', v_att.mime_type, 'organizationId', v_att.organization_id);
end;
$$;
revoke all on function public.prosm_time_announcement_file_for_reader(uuid) from public, anon;
grant execute on function public.prosm_time_announcement_file_for_reader(uuid) to authenticated;

-- service role only: the licence a media request is made under (the media service's isolation key)
create or replace function public.prosm_time_media_license(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select license_number from license_activation_state where organization_id = p_organization_id;
$$;
revoke all on function public.prosm_time_media_license(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- announcements API (readers)
create or replace function public.prosm_time_announcement_json(p_id uuid, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'title', a.title, 'body', a.body, 'requiresAck', a.requires_ack,
        'publishedAt', a.published_at, 'expiresAt', a.expires_at,
        'author', (select full_name from users where id = a.created_by),
        'viewedAt', r.viewed_at, 'acknowledgedAt', r.acknowledged_at,
        'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'url', t.url,
                                    'fileName', t.file_name, 'mimeType', t.mime_type, 'fileSize', t.file_size) order by t.created_at)
                                 from announcement_attachments t where t.announcement_id = a.id), '[]'::jsonb))
    from announcements a
    left join announcement_recipients r on r.announcement_id = a.id and r.user_id = p_user
    where a.id = p_id;
$$;
revoke all on function public.prosm_time_announcement_json(uuid, uuid) from public, anon, authenticated;

create or replace function public.list_my_prosm_time_announcements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return jsonb_build_object(
        'unread', (select count(*) from announcement_recipients r join announcements a on a.id = r.announcement_id
                   where r.user_id = v_me and a.status = 'published' and (a.expires_at is null or a.expires_at > now())
                     and (r.viewed_at is null or (a.requires_ack and r.acknowledged_at is null))),
        'items', coalesce((
            select jsonb_agg(public.prosm_time_announcement_json(a.id, v_me) order by a.published_at desc)
            from announcement_recipients r join announcements a on a.id = r.announcement_id
            where r.user_id = v_me and a.status = 'published' and (a.expires_at is null or a.expires_at > now())
        ), '[]'::jsonb));
end;
$$;
revoke all on function public.list_my_prosm_time_announcements() from public, anon;
grant execute on function public.list_my_prosm_time_announcements() to authenticated;

create or replace function public.mark_prosm_time_announcement_read(p_id uuid, p_acknowledge boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    update announcement_recipients r
    set viewed_at = coalesce(r.viewed_at, now()),
        acknowledged_at = case when p_acknowledge then coalesce(r.acknowledged_at, now()) else r.acknowledged_at end
    from announcements a
    where r.announcement_id = p_id and r.user_id = v_me and a.id = r.announcement_id
      and a.status = 'published' and (a.expires_at is null or a.expires_at > now());
    if not found then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    -- the bell follows: the notification for it is read too
    update notifications set read_at = coalesce(read_at, now())
    where user_id = v_me and type = 'announcement_published' and related_entity_id = p_id;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.mark_prosm_time_announcement_read(uuid, boolean) from public, anon;
grant execute on function public.mark_prosm_time_announcement_read(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- announcements API (management)
create or replace function public.list_prosm_time_announcements_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_wide boolean;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_wide := public.prosm_time_announcements_org_wide(v_me);
    if not v_wide and not public.prosm_time_user_has_permission_internal(v_me, 'announcements.publish') then
        raise exception 'NOT ALLOWED TO PUBLISH ANNOUNCEMENTS';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', a.id, 'kind', a.kind, 'title', a.title, 'status', a.status, 'audienceType', a.audience_type,
            'audienceCount', cardinality(a.audience_ids), 'requiresAck', a.requires_ack, 'sendEmail', a.send_email,
            'publishAt', a.publish_at, 'publishedAt', a.published_at, 'expiresAt', a.expires_at,
            'author', (select full_name from users where id = a.created_by), 'mine', a.created_by = v_me,
            'recipients', (select count(*) from announcement_recipients r where r.announcement_id = a.id),
            'viewed', (select count(*) from announcement_recipients r where r.announcement_id = a.id and r.viewed_at is not null),
            'acknowledged', (select count(*) from announcement_recipients r where r.announcement_id = a.id and r.acknowledged_at is not null),
            'createdAt', a.created_at) order by coalesce(a.published_at, a.publish_at, a.created_at) desc)
        from announcements a
        where a.organization_id = v_org and (v_wide or a.created_by = v_me)
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_announcements_admin() from public, anon;
grant execute on function public.list_prosm_time_announcements_admin() to authenticated;

create or replace function public.get_prosm_time_announcement(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_a announcements%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_a from announcements where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_a.id is null or not public.prosm_time_can_edit_announcement(v_me, p_id) then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    return public.prosm_time_announcement_json(p_id, v_me) || jsonb_build_object(
        'status', v_a.status, 'audienceType', v_a.audience_type, 'audienceIds', to_jsonb(v_a.audience_ids),
        'sendEmail', v_a.send_email, 'publishAt', v_a.publish_at, 'withdrawnReason', v_a.withdrawn_reason);
end;
$$;
revoke all on function public.get_prosm_time_announcement(uuid) from public, anon;
grant execute on function public.get_prosm_time_announcement(uuid) to authenticated;

-- who opened and who confirmed; anyone who is not organisation-wide sees the people under them only
create or replace function public.get_prosm_time_announcement_reads(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_wide boolean;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_me, 'announcements.view_reads') then raise exception 'NOT ALLOWED TO SEE WHO READ'; end if;
    if not exists (select 1 from announcements where id = p_id and organization_id = v_org) then raise exception 'ANNOUNCEMENT NOT FOUND'; end if;
    v_wide := public.prosm_time_announcements_org_wide(v_me);
    return coalesce((
        select jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.full_name, 'department', d.name,
            'viewedAt', r.viewed_at, 'acknowledgedAt', r.acknowledged_at, 'emailStatus', r.email_status)
            order by (r.acknowledged_at is not null), (r.viewed_at is not null), lower(u.full_name))
        from announcement_recipients r
        join users u on u.id = r.user_id
        left join departments d on d.id = u.department_id
        where r.announcement_id = p_id
          and (v_wide or u.id = v_me or exists (
                select 1 from site_assignments mine join site_assignments theirs on theirs.site_id = mine.site_id
                where mine.user_id = v_me and mine.role_at_site = 'manager' and theirs.user_id = u.id))
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_prosm_time_announcement_reads(uuid) from public, anon;
grant execute on function public.get_prosm_time_announcement_reads(uuid) to authenticated;

-- ---------------------------------------------------------------- schedule, expiry, email
create or replace function public.prosm_time_announcements_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row record;
    v_published integer := 0;
    v_expired integer;
begin
    for v_row in select id, created_by from announcements where status = 'scheduled' and publish_at <= now() order by publish_at limit 100 for update skip locked loop
        perform public.prosm_time_publish_announcement_now(v_row.id, v_row.created_by);
        v_published := v_published + 1;
    end loop;
    update announcements set status = 'expired', updated_at = now() where status = 'published' and expires_at is not null and expires_at <= now();
    get diagnostics v_expired = row_count;
    update announcement_recipients r set email_status = 'none'
    from announcements a where a.id = r.announcement_id and r.email_status = 'pending' and a.status <> 'published';
    return jsonb_build_object('published', v_published, 'expired', v_expired);
end;
$$;
revoke all on function public.prosm_time_announcements_tick() from public, anon, authenticated;

-- service role only (edge function announcement-email): claim pending emails
create or replace function public.prosm_time_announcement_email_claim(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_items jsonb;
begin
    with picked as (
        select r.announcement_id, r.user_id from announcement_recipients r
        join announcements a on a.id = r.announcement_id and a.status = 'published'
        where r.email_status = 'pending' and coalesce(r.email_next_at, now()) <= now()
        order by r.email_next_at nulls first
        limit greatest(1, least(p_limit, 200))
        for update of r skip locked
    ), claimed as (
        update announcement_recipients r set email_status = 'sending', email_attempts = r.email_attempts + 1
        from picked p where r.announcement_id = p.announcement_id and r.user_id = p.user_id
        returning r.announcement_id, r.user_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'announcementId', a.id, 'userId', u.id, 'email', u.email, 'name', u.full_name, 'language', u.preferred_language,
        'organization', o.name, 'kind', a.kind, 'title', a.title, 'body', a.body, 'requiresAck', a.requires_ack,
        'links', coalesce((select jsonb_agg(jsonb_build_object('title', t.title, 'url', t.url)) from announcement_attachments t where t.announcement_id = a.id and t.kind = 'link'), '[]'::jsonb),
        'files', (select count(*) from announcement_attachments t where t.announcement_id = a.id and t.kind = 'file'))), '[]'::jsonb)
    into v_items
    from claimed c join announcements a on a.id = c.announcement_id join users u on u.id = c.user_id join organizations o on o.id = a.organization_id;
    return v_items;
end;
$$;
revoke all on function public.prosm_time_announcement_email_claim(integer) from public, anon, authenticated;

create or replace function public.prosm_time_announcement_email_result(p_announcement_id uuid, p_user_id uuid, p_sent boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update announcement_recipients
    set email_status = case when p_sent then 'sent' when email_attempts >= 3 then 'failed' else 'pending' end,
        email_error = case when p_sent then null else left(coalesce(p_error, 'failed'), 300) end,
        email_next_at = case when p_sent then null else now() + (email_attempts * interval '10 minutes') end
    where announcement_id = p_announcement_id and user_id = p_user_id and email_status = 'sending';
end;
$$;
revoke all on function public.prosm_time_announcement_email_result(uuid, uuid, boolean, text) from public, anon, authenticated;

-- a claim left 'sending' by a crashed run goes back to pending after 15 minutes (in the tick)
create or replace function public.prosm_time_announcement_email_unstick()
returns void
language sql
security definer
set search_path = public
as $$
    update announcement_recipients set email_status = 'pending', email_next_at = now()
    where email_status = 'sending' and delivered_at < now() - interval '15 minutes'
      and coalesce(email_next_at, delivered_at) < now() - interval '15 minutes';
$$;
revoke all on function public.prosm_time_announcement_email_unstick() from public, anon, authenticated;

select cron.schedule('prosm-time-announcements-tick', '* * * * *', $cron$
    select public.prosm_time_announcements_tick();
    select public.prosm_time_announcement_email_unstick();
$cron$);

select cron.schedule('prosm-time-announcement-email', '* * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/announcement-email',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
        ),
        body := '{}'::jsonb
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key')
      and exists (select 1 from public.announcement_recipients where email_status = 'pending' and coalesce(email_next_at, now()) <= now());
$cron$);

commit;
