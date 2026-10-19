-- Owner 2026-10-18/19: external workforce (site workers / contractors)
-- is added for the whole organisation, not for one site, and "the app
-- generates each worker's number" - nobody types it. The worker then
-- clocks in and out with that number at the kiosk of any site.
--
-- * site_workers.site_id is optional now (kept for existing workers as
--   their home site); the 6-digit number stays unique in the organisation.
-- * create_prosm_time_external_worker() generates a free random 6-digit
--   number and returns it; list/update functions work organisation-wide.
-- * The kiosk finds the worker by number alone and records the kiosk's
--   own site - which must belong to the caller's organisation (it was
--   not checked before).
-- Same authority as before: the Owner, or sites.manage.

begin;

alter table public.site_workers alter column site_id drop not null;

-- A free 6-digit number in the organisation (never starting with 0, so it reads the same everywhere).
create or replace function public.prosm_time_new_worker_number(p_organization_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
    v_number text;
begin
    for attempt in 1..200 loop
        v_number := (100000 + floor(random() * 900000))::int::text;
        if not exists (select 1 from site_workers where organization_id = p_organization_id and worker_number = v_number) then
            return v_number;
        end if;
    end loop;
    raise exception 'NO FREE WORKER NUMBER - PLEASE TRY AGAIN';
end;
$function$;

revoke execute on function public.prosm_time_new_worker_number(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_can_manage_workforce()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select public.current_prosm_time_user_id() is not null
       and (
           public.current_prosm_time_user_is_owner()
           or 'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
       );
$function$;

revoke execute on function public.prosm_time_can_manage_workforce() from public, anon, authenticated;

create or replace function public.create_prosm_time_external_worker(p_full_name text, p_contractor_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_number text;
    v_worker_id uuid;
begin
    if not public.prosm_time_can_manage_workforce() then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;
    if p_full_name is null or length(trim(p_full_name)) = 0 then
        raise exception 'A NAME IS REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    v_number := public.prosm_time_new_worker_number(v_org);

    insert into site_workers (organization_id, site_id, full_name, worker_number, contractor_name, created_by)
    values (v_org, null, trim(p_full_name), v_number, nullif(trim(coalesce(p_contractor_name, '')), ''), public.current_prosm_time_user_id())
    returning id into v_worker_id;

    return jsonb_build_object('success', true, 'workerId', v_worker_id, 'workerNumber', v_number);
end;
$function$;

create or replace function public.list_prosm_time_external_workers()
returns table (
    id uuid,
    full_name text,
    worker_number text,
    contractor_name text,
    status text,
    current_site_name text,
    clocked_in_at timestamptz,
    created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if not public.prosm_time_can_manage_workforce() then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW SITE WORKFORCE';
    end if;
    return query
    select sw.id, sw.full_name, sw.worker_number, sw.contractor_name, sw.status, s.name, swa.clock_in_at, sw.created_at
    from site_workers sw
    left join lateral (
        select a.site_id, a.clock_in_at from site_worker_attendance a
        where a.site_worker_id = sw.id and a.clock_out_at is null
        order by a.clock_in_at desc limit 1
    ) swa on true
    left join sites s on s.id = swa.site_id
    where sw.organization_id = public.current_prosm_time_organization_id()
    order by sw.status, sw.full_name;
end;
$function$;

create or replace function public.update_prosm_time_external_worker(p_worker_id uuid, p_full_name text, p_contractor_name text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if not public.prosm_time_can_manage_workforce() then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;
    if p_full_name is null or length(trim(p_full_name)) = 0 then
        raise exception 'A NAME IS REQUIRED';
    end if;
    if p_status not in ('active', 'inactive') then
        raise exception 'INVALID STATUS';
    end if;
    update site_workers
    set full_name = trim(p_full_name), contractor_name = nullif(trim(coalesce(p_contractor_name, '')), ''), status = p_status, updated_at = now()
    where id = p_worker_id and organization_id = public.current_prosm_time_organization_id();
    if not found then
        raise exception 'WORKER NOT FOUND';
    end if;
    return jsonb_build_object('success', true);
end;
$function$;

-- Kiosk: the worker by number in the organisation, at any of its sites.
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
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active) then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO WORKER WITH THIS NUMBER';
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
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO WORKER WITH THIS NUMBER';
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

revoke execute on function public.create_prosm_time_external_worker(text, text) from public, anon;
revoke execute on function public.list_prosm_time_external_workers() from public, anon;
revoke execute on function public.update_prosm_time_external_worker(uuid, text, text, text) from public, anon;
grant execute on function public.create_prosm_time_external_worker(text, text) to authenticated, service_role;
grant execute on function public.list_prosm_time_external_workers() to authenticated, service_role;
grant execute on function public.update_prosm_time_external_worker(uuid, text, text, text) to authenticated, service_role;

commit;
