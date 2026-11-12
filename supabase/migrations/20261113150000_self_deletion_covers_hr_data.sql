-- Privacy review 2026-11-13 (owner: "make sure the privacy policy matches what the app does"): deleting one's
-- own account removed the name, email, photos, location trail and leave documents, but not what the HR file
-- added since (official name, national ID, birth date, address, mobile, emergency contact) nor the uploaded
-- documents (ID card, health certificate, licence...). They are now removed too; the files go with the account
-- (delete-my-account removes them from storage). The work records the organisation must keep - attendance,
-- timesheets, leave, allowances, payroll and payslips, contracts and penalty records - stay under "Deleted user".
-- Rollback: restore anonymize_prosm_time_user and prepare_prosm_time_self_deletion from 20261108120000-era
-- definitions (pg_get_functiondef before this migration).

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.anonymize_prosm_time_user(uuid)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def,
        '    update leave_requests set document_path = null where user_id = p_user_id;',
        '    update leave_requests set document_path = null where user_id = p_user_id;
    -- 2026-11-13: the HR file''s personal data and uploaded documents (their files are removed by delete-my-account)
    update employee_documents set file_path = null where user_id = p_user_id;
    delete from tracking_keys where user_id = p_user_id;');
    v_new := replace(v_new,
        '        hire_date = null,',
        '        hire_date = null,
        legal_name = null,
        national_id = null,
        birth_date = null,
        address = null,
        phone = null,
        emergency_contact_name = null,
        emergency_contact_phone = null,');
    if v_new = v_def or position('legal_name = null' in v_new) = 0 or position('tracking_keys' in v_new) = 0 then
        raise exception 'anonymize_prosm_time_user: anchors not found';
    end if;
    execute v_new;

    v_def := pg_get_functiondef('public.prepare_prosm_time_self_deletion()'::regprocedure);
    v_new := replace(v_def,
        '''avatarUrl'', v_user.avatar_url',
        '''avatarUrl'', v_user.avatar_url,
        ''hrDocumentPaths'', coalesce((select jsonb_agg(file_path) from employee_documents where user_id = v_user.id and file_path is not null), ''[]''::jsonb)');
    if v_new = v_def then raise exception 'prepare_prosm_time_self_deletion: anchor not found'; end if;
    execute v_new;
end $$;

commit;
