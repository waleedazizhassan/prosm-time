-- 2026-11-02 (docs/IDEAS.md 5 and 6):
--   * open shifts: a manager posts a shift with no one on it; people at the site ask
--     for it; the manager picks one, who gets it as an ordinary scheduled shift;
--   * a site's end-of-shift checklist: ticked at clock-out and kept with the shift.
-- Rollback: drop the functions below and the four tables.

begin;

create table public.open_shifts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    shift_date date not null,
    start_time time not null,
    end_time time not null check (end_time <> start_time),
    notes text,
    status text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
    filled_by uuid references public.users(id) on delete set null,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create table public.open_shift_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    open_shift_id uuid not null references public.open_shifts(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now(),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    unique (open_shift_id, user_id)
);
create table public.site_checklist_items (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    label text not null check (length(trim(label)) between 1 and 200),
    sort_order integer not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);
create table public.session_checklist_answers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    attendance_session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    item_id uuid not null references public.site_checklist_items(id) on delete cascade,
    done boolean not null,
    answered_at timestamptz not null default now(),
    unique (attendance_session_id, item_id)
);
alter table public.open_shifts enable row level security;
alter table public.open_shift_requests enable row level security;
alter table public.site_checklist_items enable row level security;
alter table public.session_checklist_answers enable row level security;
revoke all on public.open_shifts, public.open_shift_requests, public.site_checklist_items, public.session_checklist_answers from anon, authenticated;

-- Open shifts -----------------------------------------------------------------

create or replace function public.create_prosm_time_open_shift(p_site_id uuid, p_shift_date date, p_start_time time, p_end_time time, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if not public.prosm_time_can_manage_site_shifts(p_site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id()) then raise exception 'SITE NOT FOUND'; end if;
    if p_shift_date < current_date then raise exception 'THIS SHIFT IS IN THE PAST'; end if;
    insert into open_shifts (organization_id, site_id, shift_date, start_time, end_time, notes, created_by)
    values (public.current_prosm_time_organization_id(), p_site_id, p_shift_date, p_start_time, p_end_time, nullif(trim(coalesce(p_notes, '')), ''), public.current_prosm_time_user_id())
    returning id into v_id;
    return v_id;
end;
$$;

create or replace function public.cancel_prosm_time_open_shift(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_shift open_shifts%rowtype;
begin
    select * into v_shift from open_shifts where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_shift.id is null then raise exception 'OPEN SHIFT NOT FOUND'; end if;
    if not public.prosm_time_can_manage_site_shifts(v_shift.site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
    update open_shifts set status = 'cancelled' where id = p_id and status = 'open';
end;
$$;

-- Open shifts the caller can ask for (their sites), or manages; with requests for managers.
create or replace function public.list_prosm_time_open_shifts()
returns table (id uuid, site_id uuid, site_name text, shift_date date, start_time time, end_time time, notes text, status text,
               my_request text, can_manage boolean, requests jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return query
    select o.id, o.site_id, s.name, o.shift_date, o.start_time, o.end_time, o.notes, o.status,
           (select r.status from open_shift_requests r where r.open_shift_id = o.id and r.user_id = v_me),
           public.prosm_time_can_manage_site_shifts(o.site_id),
           case when public.prosm_time_can_manage_site_shifts(o.site_id) then coalesce((
               select jsonb_agg(jsonb_build_object('id', r.id, 'name', u.full_name, 'status', r.status) order by r.created_at)
               from open_shift_requests r join users u on u.id = r.user_id where r.open_shift_id = o.id), '[]'::jsonb) else '[]'::jsonb end
    from open_shifts o join sites s on s.id = o.site_id
    where o.organization_id = public.current_prosm_time_organization_id()
      and o.shift_date >= current_date - 1
      and (o.status = 'open' or public.prosm_time_can_manage_site_shifts(o.site_id))
      and (public.prosm_time_can_manage_site_shifts(o.site_id) or exists (select 1 from site_assignments sa where sa.site_id = o.site_id and sa.user_id = v_me))
    order by o.shift_date, o.start_time
    limit 100;
end;
$$;

create or replace function public.request_prosm_time_open_shift(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_shift open_shifts%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_shift from open_shifts where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_shift.id is null or v_shift.status <> 'open' then raise exception 'OPEN SHIFT NOT FOUND'; end if;
    if not exists (select 1 from site_assignments where site_id = v_shift.site_id and user_id = v_me) then raise exception 'YOU ARE NOT AT THIS SITE'; end if;
    insert into open_shift_requests (organization_id, open_shift_id, user_id) values (v_shift.organization_id, p_id, v_me)
    on conflict (open_shift_id, user_id) do nothing;
end;
$$;

create or replace function public.decide_prosm_time_open_shift_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request open_shift_requests%rowtype;
    v_shift open_shifts%rowtype;
    v_start timestamp;
    v_end timestamp;
    v_assignment uuid;
begin
    select * into v_request from open_shift_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    select * into v_shift from open_shifts where id = v_request.open_shift_id for update;
    if not public.prosm_time_can_manage_site_shifts(v_shift.site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
    if v_request.status <> 'pending' or v_shift.status <> 'open' then raise exception 'THIS REQUEST WAS ALREADY DECIDED'; end if;

    if p_approve then
        if exists (select 1 from leave_requests where user_id = v_request.user_id and status = 'approved' and v_shift.shift_date between start_date and end_date) then
            raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE ON THIS DATE';
        end if;
        v_start := v_shift.shift_date + v_shift.start_time;
        v_end := v_shift.shift_date + v_shift.end_time + (case when v_shift.end_time <= v_shift.start_time then interval '1 day' else interval '0' end);
        if exists (
            select 1 from shift_assignments sa
            where sa.user_id = v_request.user_id and sa.status = 'scheduled'
              and sa.shift_date between v_shift.shift_date - 1 and v_shift.shift_date + 1
              and v_start < (sa.shift_date + sa.end_time + (case when sa.end_time <= sa.start_time then interval '1 day' else interval '0' end))
              and v_end > (sa.shift_date + sa.start_time)
        ) then
            raise exception 'THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE';
        end if;
        insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time, notes, created_by)
        values (v_shift.organization_id, v_request.user_id, v_shift.site_id, v_shift.shift_date, v_shift.start_time, v_shift.end_time, v_shift.notes, v_me)
        returning id into v_assignment;
        update open_shifts set status = 'filled', filled_by = v_request.user_id where id = v_shift.id;
        update open_shift_requests set status = 'rejected', reviewed_by = v_me, reviewed_at = now() where open_shift_id = v_shift.id and id <> p_request_id and status = 'pending';
        perform public.create_prosm_time_notification(
            v_shift.organization_id, v_request.user_id, 'shift_assigned', 'normal', 'A new shift was scheduled for you',
            'You are scheduled on ' || v_shift.shift_date::text || ' from ' || v_shift.start_time::text || ' to ' || v_shift.end_time::text || '.',
            'shift_assignments', v_assignment,
            jsonb_build_object('shiftDate', v_shift.shift_date, 'startTime', v_shift.start_time, 'endTime', v_shift.end_time, 'crossesMidnight', v_shift.end_time <= v_shift.start_time)
        );
    end if;
    update open_shift_requests set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = v_me, reviewed_at = now() where id = p_request_id;
end;
$$;

-- Checklists --------------------------------------------------------------------

create or replace function public.set_prosm_time_site_checklist(p_site_id uuid, p_labels text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_label text;
    v_index integer := 0;
begin
    if not public.prosm_time_can_manage_site_shifts(p_site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
    if cardinality(coalesce(p_labels, array[]::text[])) > 20 then raise exception 'TOO MANY ITEMS'; end if;
    -- earlier items stay for the shifts that answered them, but leave the list
    update site_checklist_items set is_active = false where site_id = p_site_id and is_active;
    foreach v_label in array coalesce(p_labels, array[]::text[]) loop
        continue when length(trim(v_label)) = 0;
        v_index := v_index + 1;
        insert into site_checklist_items (organization_id, site_id, label, sort_order)
        values (public.current_prosm_time_organization_id(), p_site_id, trim(v_label), v_index);
    end loop;
end;
$$;

create or replace function public.list_prosm_time_site_checklist(p_site_id uuid)
returns table (id uuid, label text)
language sql
stable
security definer
set search_path = public
as $$
    select i.id, i.label from site_checklist_items i
    where i.site_id = p_site_id and i.is_active and i.organization_id = public.current_prosm_time_organization_id()
    order by i.sort_order;
$$;

create or replace function public.record_prosm_time_session_checklist(p_session_id uuid, p_done_item_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session attendance_sessions%rowtype;
begin
    select * into v_session from attendance_sessions where id = p_session_id and organization_id = public.current_prosm_time_organization_id();
    if v_session.id is null or v_session.user_id <> public.current_prosm_time_user_id() then raise exception 'SHIFT NOT FOUND'; end if;
    insert into session_checklist_answers (organization_id, attendance_session_id, item_id, done)
    select v_session.organization_id, p_session_id, i.id, i.id = any(coalesce(p_done_item_ids, array[]::uuid[]))
    from site_checklist_items i where i.site_id = v_session.site_id and i.is_active
    on conflict (attendance_session_id, item_id) do update set done = excluded.done, answered_at = now();
end;
$$;

-- For the record: what was ticked on a shift, for the person and their managers.
create or replace function public.list_prosm_time_session_checklist(p_session_id uuid)
returns table (label text, done boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_session attendance_sessions%rowtype;
begin
    select * into v_session from attendance_sessions where id = p_session_id and organization_id = public.current_prosm_time_organization_id();
    if v_session.id is null then raise exception 'SHIFT NOT FOUND'; end if;
    if v_session.user_id <> public.current_prosm_time_user_id() and not public.prosm_time_can_manage_site_shifts(v_session.site_id)
       and not (public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'attendance.view') and v_session.site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'SHIFT NOT FOUND';
    end if;
    return query
    select i.label, a.done from session_checklist_answers a join site_checklist_items i on i.id = a.item_id
    where a.attendance_session_id = p_session_id order by i.sort_order;
end;
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array[
        'create_prosm_time_open_shift(uuid, date, time, time, text)', 'cancel_prosm_time_open_shift(uuid)', 'list_prosm_time_open_shifts()',
        'request_prosm_time_open_shift(uuid)', 'decide_prosm_time_open_shift_request(uuid, boolean)', 'set_prosm_time_site_checklist(uuid, text[])',
        'list_prosm_time_site_checklist(uuid)', 'record_prosm_time_session_checklist(uuid, uuid[])', 'list_prosm_time_session_checklist(uuid)'
    ] loop
        execute format('revoke all on function public.%s from public, anon', v_fn);
        execute format('grant execute on function public.%s to authenticated', v_fn);
    end loop;
end $$;

commit;
