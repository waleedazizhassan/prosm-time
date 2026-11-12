-- Demo run 2026-11-12: when personnel refused an upload, the person's list still showed the document as
-- "missing" with no reason - only the notification said why. Now the latest refusal (newer than the
-- document in force, with nothing waiting for review) shows in the list: status "rejected" where the
-- document is missing, and its reason in every case, so the person knows what to photograph again.
-- Rollback: restore list_prosm_time_employee_documents from 20261111210000_employee_documents.sql.

begin;

create or replace function public.list_prosm_time_employee_documents(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_access text := public.prosm_time_profile_access(p_user_id);
    v_today date := (now() at time zone public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user_id), public.current_prosm_time_organization_id()))::date;
begin
    if v_access not in ('full', 'self') then raise exception 'PERMISSION DENIED'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'typeId', t.id, 'typeName', t.name, 'isMandatory', t.is_mandatory, 'hasExpiry', t.has_expiry,
            'status', case when d.status = 'missing' and r.id is not null then 'rejected' else d.status end,
            'isCurrent', d.is_current, 'documentNumber', d.document_number, 'issueDate', d.issue_date, 'expiryDate', d.expiry_date,
            'daysLeft', case when d.expiry_date is not null then d.expiry_date - v_today end,
            'hasFile', d.file_path is not null, 'filePath', d.file_path, 'uploadedAt', d.uploaded_at, 'reviewedAt', d.reviewed_at,
            'rejectionReason', coalesce(r.rejection_reason, d.rejection_reason), 'lastRemindedAt', d.last_reminded_at,
            'pending', (select jsonb_build_object('id', p.id, 'filePath', p.file_path, 'expiryDate', p.expiry_date, 'documentNumber', p.document_number, 'uploadedAt', p.uploaded_at)
                        from employee_documents p where p.user_id = d.user_id and p.document_type_id = d.document_type_id and not p.is_current and p.status = 'pending_review' order by p.created_at desc limit 1),
            'pendingId', (select p.id from employee_documents p where p.user_id = d.user_id and p.document_type_id = d.document_type_id and not p.is_current and p.status = 'pending_review' order by p.created_at desc limit 1),
            'archived', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'documentNumber', a.document_number, 'expiryDate', a.expiry_date, 'filePath', a.file_path, 'status', a.status, 'uploadedAt', a.uploaded_at) order by a.created_at desc)
                                  from employee_documents a where a.user_id = d.user_id and a.document_type_id = d.document_type_id and not a.is_current and a.status <> 'pending_review'), '[]'::jsonb))
            order by t.is_mandatory desc, t.name)
        from employee_documents d
        join document_types t on t.id = d.document_type_id
        -- the latest refusal newer than the document in force, while nothing newer waits for review
        left join lateral (
            select x.id, x.rejection_reason from employee_documents x
            where x.user_id = d.user_id and x.document_type_id = d.document_type_id and not x.is_current and x.status = 'rejected'
              and x.created_at > coalesce(d.uploaded_at, '-infinity'::timestamptz)
              and not exists (select 1 from employee_documents y where y.user_id = d.user_id and y.document_type_id = d.document_type_id
                              and not y.is_current and y.status = 'pending_review' and y.created_at > x.created_at)
            order by x.created_at desc limit 1
        ) r on true
        where d.user_id = p_user_id and d.is_current and t.is_active
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_employee_documents(uuid) from public, anon;
grant execute on function public.list_prosm_time_employee_documents(uuid) to authenticated;

commit;
