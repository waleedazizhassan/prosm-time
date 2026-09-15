-- § user-directed, 2026-09-15 - "the API I tried transferred nothing
-- at all - I want it to move sites, people, contractor labor too, not
-- just cost numbers." Follow-up direction: PROSM Time feeds the
-- Payroll/workforce side of PROSM Finance, PROSM Projects feeds the
-- project-cost side. This is Time's half: two new read-only export
-- RPCs (sites, and the full worker roster - employees AND site-worker
-- contractor labor) so Finance can show a real, browsable directory
-- instead of only deriving names from attendance records that already
-- happen to exist. Same access posture as list_prosm_time_attendance_
-- export - service_role only, called from the export-sites/export-
-- workers Edge Functions after authenticate_prosm_time_api_key.
begin;

create or replace function public.list_prosm_time_sites_export(p_organization_id uuid)
returns table (
    site_id uuid,
    name text,
    is_active boolean
)
language sql
stable
security definer
set search_path = public
as $function$
    select s.id, s.name, s.is_active
    from sites s
    where s.organization_id = p_organization_id
    order by s.name;
$function$;

revoke execute on function public.list_prosm_time_sites_export(uuid) from public, anon, authenticated;
grant execute on function public.list_prosm_time_sites_export(uuid) to service_role;

-- Employees (users table) and site-worker contractor labor
-- (site_workers table, kiosk-based, no login account - §
-- 20260910100000's own header) are two different tables with no
-- shared identity - unioned here into one worker_type-tagged roster,
-- the same worker_type vocabulary (EMPLOYEE/SITE_WORKER) already used
-- by export-attendance/export-worker-attendance so a consuming
-- product never has to invent its own mapping.
create or replace function public.list_prosm_time_workers_export(p_organization_id uuid)
returns table (
    worker_type text,
    worker_id text,
    name text,
    status text,
    site_id uuid
)
language sql
stable
security definer
set search_path = public
as $function$
    select 'EMPLOYEE', u.id::text, u.full_name, u.status, null::uuid
    from users u
    where u.organization_id = p_organization_id

    union all

    select 'SITE_WORKER', sw.id::text, sw.full_name, sw.status, sw.site_id
    from site_workers sw
    where sw.organization_id = p_organization_id

    order by 3;
$function$;

revoke execute on function public.list_prosm_time_workers_export(uuid) from public, anon, authenticated;
grant execute on function public.list_prosm_time_workers_export(uuid) to service_role;

commit;
