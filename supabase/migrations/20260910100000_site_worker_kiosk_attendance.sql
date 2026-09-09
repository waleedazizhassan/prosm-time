-- PROSM Time - real, user-directed feature: external/contractor
-- workforce (عمالة خارجية للمقاولين) tracked via Kiosk mode, genuinely
-- separate from "employees" (who have full email/password accounts +
-- kiosk PINs). A site manager/Owner adds each worker and assigns a
-- single 6-digit number - that number ALONE is both identity and
-- kiosk credential, no separate PIN. No photo required; a real GPS
-- sample is mandatory at both clock-in and clock-out (mirrors
-- 20260909300000's own "no-site still gets a real GPS sample"
-- posture, applied here from the start rather than retrofitted).
--
-- Deliberately a separate table pair from users/attendance_sessions -
-- these are not PROSM Time user accounts (no login, no email, no
-- permission grants) and mixing them into the employee model would
-- both be wrong conceptually and would trip the Anti-Crack
-- installation-gate machinery that's scoped to real user sessions.

begin;

create table public.site_workers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    full_name text not null,
    worker_number text not null check (worker_number ~ '^[0-9]{6}$'),
    status text not null default 'active' check (status in ('active', 'inactive')),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, worker_number)
);

create index site_workers_org_idx on public.site_workers(organization_id);
create index site_workers_site_idx on public.site_workers(site_id);

create table public.site_worker_attendance (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_worker_id uuid not null references public.site_workers(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    clock_in_at timestamptz not null default now(),
    clock_out_at timestamptz,
    clock_in_latitude double precision not null,
    clock_in_longitude double precision not null,
    clock_out_latitude double precision,
    clock_out_longitude double precision,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index site_worker_attendance_org_idx on public.site_worker_attendance(organization_id);
create index site_worker_attendance_worker_idx on public.site_worker_attendance(site_worker_id);
create index site_worker_attendance_open_idx on public.site_worker_attendance(site_worker_id) where clock_out_at is null;

alter table public.site_workers enable row level security;
alter table public.site_worker_attendance enable row level security;

revoke all on public.site_workers from anon, authenticated;
revoke all on public.site_worker_attendance from anon, authenticated;
grant select on public.site_workers to authenticated;
grant select on public.site_worker_attendance to authenticated;

-- Same "own org, sites.manage or Owner" visibility as every other
-- site-scoped management data (site policy, shift scheduling).
create policy "managers view own organization site workers"
on public.site_workers for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
    )
);

create policy "managers view own organization site worker attendance"
on public.site_worker_attendance for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
    )
);

create or replace function public.create_prosm_time_site_worker(
    p_site_id uuid,
    p_full_name text,
    p_worker_number text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_worker_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;
    if p_full_name is null or length(trim(p_full_name)) = 0 then
        raise exception 'A NAME IS REQUIRED';
    end if;
    if p_worker_number !~ '^[0-9]{6}$' then
        raise exception 'THE WORKER NUMBER MUST BE EXACTLY 6 DIGITS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;
    if exists (select 1 from site_workers sw where sw.organization_id = v_org and sw.worker_number = p_worker_number) then
        raise exception 'THIS WORKER NUMBER IS ALREADY IN USE';
    end if;

    insert into site_workers (organization_id, site_id, full_name, worker_number, created_by)
    values (v_org, p_site_id, trim(p_full_name), p_worker_number, v_caller_id)
    returning id into v_worker_id;

    return jsonb_build_object('success', true, 'workerId', v_worker_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME SITE WORKER FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.list_prosm_time_site_workers(p_site_id uuid)
returns table (
    id uuid,
    full_name text,
    worker_number text,
    status text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW SITE WORKFORCE';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    return query
    select sw.id, sw.full_name, sw.worker_number, sw.status, sw.created_at
    from site_workers sw
    where sw.organization_id = v_org and sw.site_id = p_site_id
    order by sw.created_at desc;
end;
$function$;

create or replace function public.deactivate_prosm_time_site_worker(p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from site_workers sw where sw.id = p_worker_id and sw.organization_id = v_org) then
        raise exception 'SITE WORKER NOT FOUND';
    end if;

    update site_workers set status = 'inactive', updated_at = now() where id = p_worker_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DEACTIVATE PROSM TIME SITE WORKER FAILED: %', sqlerrm;
end;
$function$;

-- Kiosk-facing: caller is whoever is signed into the operating kiosk
-- device (same posture as kiosk_clock_in_prosm_time_attendance - the
-- WORKER's own identity is proven by their 6-digit number, not by the
-- caller's session, which only establishes the organization/site
-- context). Real GPS sample is mandatory (no default/fallback) per
-- the user's own explicit requirement.
create or replace function public.kiosk_worker_clock_in(
    p_site_id uuid,
    p_worker_number text,
    p_latitude double precision,
    p_longitude double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_org uuid;
    v_worker site_workers%rowtype;
    v_open_entry site_worker_attendance%rowtype;
    v_entry_id uuid;
begin
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_latitude is null or p_longitude is null then
        raise exception 'A REAL GPS SAMPLE IS REQUIRED';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and site_id = p_site_id and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO ACTIVE WORKER WITH THIS NUMBER AT THIS SITE';
    end if;
    if v_worker.status <> 'active' then
        raise exception 'THIS WORKER IS NOT ACTIVE';
    end if;

    select * into v_open_entry from site_worker_attendance where site_worker_id = v_worker.id and clock_out_at is null;
    if v_open_entry.id is not null then
        raise exception 'THIS WORKER IS ALREADY CLOCKED IN';
    end if;

    insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_latitude, clock_in_longitude)
    values (v_caller_org, v_worker.id, p_site_id, p_latitude, p_longitude)
    returning id into v_entry_id;

    return jsonb_build_object('success', true, 'entryId', v_entry_id, 'workerName', v_worker.full_name);
exception
    when others then
        raise exception 'KIOSK WORKER CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.kiosk_worker_clock_out(
    p_site_id uuid,
    p_worker_number text,
    p_latitude double precision,
    p_longitude double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_org uuid;
    v_worker site_workers%rowtype;
    v_open_entry site_worker_attendance%rowtype;
begin
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_latitude is null or p_longitude is null then
        raise exception 'A REAL GPS SAMPLE IS REQUIRED';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and site_id = p_site_id and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO ACTIVE WORKER WITH THIS NUMBER AT THIS SITE';
    end if;

    select * into v_open_entry from site_worker_attendance where site_worker_id = v_worker.id and clock_out_at is null order by clock_in_at desc limit 1;
    if v_open_entry.id is null then
        raise exception 'THIS WORKER IS NOT CURRENTLY CLOCKED IN';
    end if;

    update site_worker_attendance
    set clock_out_at = now(), clock_out_latitude = p_latitude, clock_out_longitude = p_longitude, updated_at = now()
    where id = v_open_entry.id;

    return jsonb_build_object('success', true, 'entryId', v_open_entry.id, 'workerName', v_worker.full_name);
exception
    when others then
        raise exception 'KIOSK WORKER CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

-- Reporting: a date-range list for the Reports Center, same
-- Owner/sites.manage gate as the management RPCs above.
create or replace function public.list_prosm_time_site_worker_attendance(
    p_site_id uuid default null,
    p_start_date date default null,
    p_end_date date default null
)
returns table (
    id uuid,
    worker_name text,
    worker_number text,
    site_name text,
    clock_in_at timestamptz,
    clock_out_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW SITE WORKFORCE ATTENDANCE';
    end if;

    v_org := public.current_prosm_time_organization_id();

    return query
    select swa.id, sw.full_name, sw.worker_number, s.name, swa.clock_in_at, swa.clock_out_at
    from site_worker_attendance swa
    join site_workers sw on sw.id = swa.site_worker_id
    join sites s on s.id = swa.site_id
    where swa.organization_id = v_org
      and (p_site_id is null or swa.site_id = p_site_id)
      and (p_start_date is null or swa.clock_in_at::date >= p_start_date)
      and (p_end_date is null or swa.clock_in_at::date <= p_end_date)
    order by swa.clock_in_at desc;
end;
$function$;

-- Service-role-only: what export-worker-attendance (Edge Function)
-- calls after authenticate_prosm_time_api_key already resolved the
-- caller's organization - same posture as list_prosm_time_attendance_
-- export.
create or replace function public.list_prosm_time_worker_attendance_export(
    p_organization_id uuid,
    p_since timestamptz,
    p_until timestamptz
)
returns table (
    entry_id uuid,
    worker_name text,
    worker_number text,
    site_name text,
    clock_in_at timestamptz,
    clock_out_at timestamptz,
    clock_in_latitude double precision,
    clock_in_longitude double precision
)
language plpgsql
security definer
set search_path = public
as $function$
begin
    return query
    select swa.id, sw.full_name, sw.worker_number, s.name, swa.clock_in_at, swa.clock_out_at, swa.clock_in_latitude, swa.clock_in_longitude
    from site_worker_attendance swa
    join site_workers sw on sw.id = swa.site_worker_id
    join sites s on s.id = swa.site_id
    where swa.organization_id = p_organization_id
      and swa.clock_in_at >= p_since and swa.clock_in_at <= p_until
    order by swa.clock_in_at asc;
end;
$function$;

revoke execute on function public.create_prosm_time_site_worker(uuid, text, text) from public, anon;
revoke execute on function public.list_prosm_time_site_workers(uuid) from public, anon;
revoke execute on function public.deactivate_prosm_time_site_worker(uuid) from public, anon;
revoke execute on function public.kiosk_worker_clock_in(uuid, text, double precision, double precision) from public, anon;
revoke execute on function public.kiosk_worker_clock_out(uuid, text, double precision, double precision) from public, anon;
revoke execute on function public.list_prosm_time_site_worker_attendance(uuid, date, date) from public, anon;
revoke execute on function public.list_prosm_time_worker_attendance_export(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.list_prosm_time_worker_attendance_export(uuid, timestamptz, timestamptz) to service_role;

commit;
