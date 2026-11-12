-- Owner 2026-11-12: "adding documents should be from the employee's file, not from Settings; a document with an
-- expiry has its state (valid / expired), its start and end dates, and the reminder comes before the end".
-- Personnel (owner, hr.manage) add any document from a person's file by its name: an existing kind of
-- document of the organisation is reused (same name, any case), otherwise a new kind is made for that
-- name - not required of anyone, so it is only on the files it was added to. The upload itself is the
-- existing one (submit_prosm_time_document: number, start date, end date, file; accepted at once when
-- personnel add it), and the expiry reminders (30, 7 and 0 days before the end) already follow every
-- document with an end date.
-- Rollback: drop function ensure_prosm_time_person_document_type(uuid, text, boolean).

begin;

create or replace function public.ensure_prosm_time_person_document_type(p_user_id uuid, p_name text, p_has_expiry boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
    v_type document_types%rowtype;
begin
    if public.prosm_time_profile_access(p_user_id) <> 'full' then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_require_feature('documents');
    if char_length(v_name) = 0 then raise exception 'THE DOCUMENT NAME IS REQUIRED'; end if;
    if char_length(v_name) > 100 then raise exception 'THE DOCUMENT NAME IS TOO LONG'; end if;
    select * into v_type from document_types where organization_id = v_org and is_active and lower(name) = lower(v_name) order by created_at limit 1;
    if v_type.id is null then
        -- applies to nobody by itself: it lives only on the files it is added to
        insert into document_types (organization_id, name, is_mandatory, has_expiry, applies_to, job_title_ids)
        values (v_org, v_name, false, coalesce(p_has_expiry, true), 'job_titles', '{}')
        returning * into v_type;
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
        values (v_org, public.current_prosm_time_user_id(), p_user_id, 'hr.document_type_saved', 'document_types', v_type.id,
                'Document kind added from a file', jsonb_build_object('name', v_name, 'hasExpiry', v_type.has_expiry));
    end if;
    return jsonb_build_object('id', v_type.id, 'name', v_type.name, 'hasExpiry', v_type.has_expiry);
end;
$$;
revoke all on function public.ensure_prosm_time_person_document_type(uuid, text, boolean) from public, anon;
grant execute on function public.ensure_prosm_time_person_document_type(uuid, text, boolean) to authenticated;

commit;
