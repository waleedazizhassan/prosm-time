-- PROSM Time - 14-point live-audit gap #7: site_workers/
-- site_worker_attendance (the external/contractor Kiosk system,
-- 20260910100000) had no contractor field and no admin-override-with-
-- audit path for a worker who leaves without clocking out - unlike the
-- already-real admin_clock_out_prosm_time_attendance path for regular
-- employees.
--
-- "Contractor field": PROSM Projects (a separate repo/Supabase project
-- entirely) already models contractor_id as a LOCAL foreign key inside
-- ITS OWN database. The two products are bridged only by worker_number
-- matching (sync-prosm-time-attendance there) - there is no live
-- cross-database foreign key possible or desired. So the real, honest
-- addition here is a free-text contractor_name on site_workers, letting
-- a site manager/Owner group/tag/report on which contracting company an
-- external worker belongs to within PROSM Time itself.
begin;

alter table public.site_workers add column contractor_name text;

-- Both functions below change shape (a new parameter with a default,
-- and a new RETURNS TABLE column set respectively) - CREATE OR REPLACE
-- alone would leave the OLD signature/shape alongside the new one
-- (an ambiguous-overload / return-type-change error, a pitfall this
-- session has hit before), so drop the exact old signatures first.
drop function if exists public.create_prosm_time_site_worker(uuid, text, text);
drop function if exists public.list_prosm_time_site_workers(uuid);

create or replace function public.create_prosm_time_site_worker(
    p_site_id uuid,
    p_full_name text,
    p_worker_number text,
    p_contractor_name text default null
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

    insert into site_workers (organization_id, site_id, full_name, worker_number, contractor_name, created_by)
    values (v_org, p_site_id, trim(p_full_name), p_worker_number, nullif(trim(coalesce(p_contractor_name, '')), ''), v_caller_id)
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
    contractor_name text,
    status text,
    has_open_session boolean,
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
    select
        sw.id, sw.full_name, sw.worker_number, sw.contractor_name, sw.status,
        exists (select 1 from site_worker_attendance swa where swa.site_worker_id = sw.id and swa.clock_out_at is null),
        sw.created_at
    from site_workers sw
    where sw.organization_id = v_org and sw.site_id = p_site_id
    order by sw.created_at desc;
end;
$function$;

-- Mirrors admin_clock_out_prosm_time_attendance's own real audit-trail
-- pattern (20260831180000) - same authority check, same audit_logs
-- insert. site_worker_attendance has no admin_on_behalf_actions-style
-- side table of its own (that table is employee-attendance-specific);
-- audit_logs' generic context jsonb column carries everything needed
-- for a worker-clock-out override.
create or replace function public.admin_clock_out_prosm_time_site_worker(
    p_worker_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_worker site_workers%rowtype;
    v_open_row site_worker_attendance%rowtype;
    v_audit_log_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_worker from site_workers where id = p_worker_id and organization_id = v_org;
    if v_worker.id is null then
        raise exception 'SITE WORKER NOT FOUND';
    end if;

    select * into v_open_row from site_worker_attendance
    where site_worker_id = p_worker_id and clock_out_at is null
    order by clock_in_at desc
    limit 1;
    if v_open_row.id is null then
        raise exception 'THIS WORKER IS NOT CURRENTLY CLOCKED IN';
    end if;

    update site_worker_attendance
    set clock_out_at = now(), updated_at = now()
    where id = v_open_row.id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_org, v_caller_id, null, 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF', 'site_worker_attendance', v_open_row.id,
        v_worker.full_name || ' (site worker) clocked out by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('workerId', v_worker.id, 'workerNumber', v_worker.worker_number, 'attendanceId', v_open_row.id)
    )
    returning id into v_audit_log_id;

    return jsonb_build_object('success', true, 'attendanceId', v_open_row.id, 'auditLogId', v_audit_log_id);
exception
    when others then
        raise exception 'ADMIN CLOCK OUT SITE WORKER FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.create_prosm_time_site_worker(uuid, text, text, text) to authenticated;
grant execute on function public.list_prosm_time_site_workers(uuid) to authenticated;
grant execute on function public.admin_clock_out_prosm_time_site_worker(uuid, text) to authenticated;

commit;
