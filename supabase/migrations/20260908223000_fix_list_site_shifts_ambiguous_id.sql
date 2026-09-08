-- PROSM Time - real bug caught live, same class as list_prosm_time_
-- attendance_export's own fix earlier this same session
-- (20260908191000): list_prosm_time_site_shifts's RETURNS TABLE
-- declares an OUT parameter literally named `id`, and its own site-
-- existence check referenced `sites.id` unqualified ("where id =
-- p_site_id") - ambiguous with that OUT parameter, SQLSTATE 42702,
-- confirmed live via the real admin@prosm.net account. Qualifies it.

begin;

create or replace function public.list_prosm_time_site_shifts(
    p_site_id uuid,
    p_start_date date,
    p_end_date date
)
returns table (
    id uuid,
    user_id uuid,
    employee_name text,
    shift_date date,
    start_time time,
    end_time time,
    status text,
    notes text,
    cancelled_reason text
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
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE SITE SCHEDULE';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    return query
    select sa.id, sa.user_id, u.full_name, sa.shift_date, sa.start_time, sa.end_time, sa.status, sa.notes, sa.cancelled_reason
    from shift_assignments sa
    join users u on u.id = sa.user_id
    where sa.organization_id = v_org and sa.site_id = p_site_id
      and sa.shift_date between p_start_date and p_end_date
    order by sa.shift_date asc, sa.start_time asc;
end;
$function$;

commit;
