-- Owner 2026-11-12 (agreed): documents are added from the person's file; a small "required from every employee"
-- choice there (and on each document) makes a kind of document required of all - everyone's file gets it as
-- missing, the completeness bar and reminders follow - with an optional "no clock-in once it has expired" (e.g. a
-- factory's health certificate). Turned off, it is on nobody's file by itself again (uploaded ones stay).
-- Rollback: drop function set_prosm_time_document_required(uuid, boolean, boolean).

begin;

create or replace function public.set_prosm_time_document_required(p_type_id uuid, p_required boolean, p_block_clock_in boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_person uuid;
    v_name text;
begin
    if not public.prosm_time_is_hr() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_require_feature('documents');
    update document_types set
        is_mandatory = coalesce(p_required, false),
        applies_to = case when p_required then 'all' else 'job_titles' end,
        job_title_ids = case when p_required then job_title_ids else '{}' end,
        site_ids = case when p_required then site_ids else '{}' end,
        clock_in_rule = case when p_required and p_block_clock_in then 'block' else 'none' end,
        is_active = true,
        updated_at = now()
    where id = p_type_id and organization_id = v_org
    returning name into v_name;
    if v_name is null then raise exception 'DOCUMENT TYPE NOT FOUND'; end if;
    -- everyone's list follows (a newly required document reaches each person as missing, with a notification)
    for v_person in select id from users where organization_id = v_org and is_active and not is_owner loop
        perform public.prosm_time_sync_person_documents(v_person, coalesce(p_required, false));
    end loop;
    update employee_documents set status = case when p_required then 'missing' else 'not_required' end
    where document_type_id = p_type_id and is_current and status in ('missing', 'not_required') and file_path is null;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.document_type_saved', 'document_types', p_type_id,
            case when p_required then 'Document required from every employee' else 'Document no longer required from everyone' end,
            jsonb_build_object('name', v_name, 'required', p_required, 'blockClockIn', coalesce(p_block_clock_in, false)));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_document_required(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_prosm_time_document_required(uuid, boolean, boolean) to authenticated;

commit;
