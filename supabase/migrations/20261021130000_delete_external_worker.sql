-- Owner 2026-10-21 ("a button to remove or edit an external worker"). Editing
-- already existed on the server (update_prosm_time_external_worker); removing
-- is new: a worker added by mistake, with no attendance, is deleted for good.
-- A worker with attendance is never deleted - their hours are part of the
-- payroll history - and is stopped (inactive) instead.

begin;

create or replace function public.delete_prosm_time_external_worker(p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_name text;
begin
    if not public.prosm_time_can_manage_workforce() then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SITE WORKFORCE';
    end if;
    select full_name into v_name from site_workers where id = p_worker_id and organization_id = v_org;
    if v_name is null then
        raise exception 'WORKER NOT FOUND';
    end if;
    if exists (select 1 from site_worker_attendance where site_worker_id = p_worker_id) then
        raise exception 'THIS WORKER HAS ATTENDANCE - STOP THEM INSTEAD';
    end if;

    delete from site_workers where id = p_worker_id and organization_id = v_org;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, public.current_prosm_time_user_id(), 'EXTERNAL_WORKER_DELETED', 'site_workers', p_worker_id, 'External worker ' || v_name || ' deleted.');

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.delete_prosm_time_external_worker(uuid) from public, anon;
grant execute on function public.delete_prosm_time_external_worker(uuid) to authenticated;

commit;
