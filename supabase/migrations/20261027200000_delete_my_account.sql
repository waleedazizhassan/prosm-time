-- v2.3.55 (owner 2026-10-27, for Google Play: "the user can delete their
-- account from the user menu"):
-- a person deletes their own account. Their sign-in stops for good and
-- everything that identifies them goes: name, email, picture, the photos
-- taken at clock-in and clock-out, their location trail, leave documents,
-- phones registered for notifications, devices, notifications and layout.
-- The organisation keeps the work records it must keep for payroll and the
-- law (attendance, timesheets, leave, allowances), under "Deleted user".
-- The Owner's account cannot be deleted this way (it holds the
-- organisation): the Owner asks PROSM support.
-- The sign-in account is scrubbed and banned by the delete-my-account
-- function rather than deleted: deleting it would cascade to these records.

begin;

-- what the deletion must also remove from storage, and whether it may run
create or replace function public.prepare_prosm_time_self_deletion()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user users%rowtype;
begin
    select * into v_user from users where id = public.current_prosm_time_user_id();
    if v_user.id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if v_user.is_owner then
        return jsonb_build_object('authorized', false, 'reason', 'owner');
    end if;
    if exists (select 1 from attendance_sessions where user_id = v_user.id and status = 'clocked_in') then
        return jsonb_build_object('authorized', false, 'reason', 'clocked_in');
    end if;
    return jsonb_build_object(
        'authorized', true,
        'userId', v_user.id,
        'authUserId', v_user.auth_user_id,
        'organizationId', v_user.organization_id,
        'evidencePaths', coalesce((select jsonb_agg(storage_path) from camera_evidence where user_id = v_user.id and storage_path is not null), '[]'::jsonb),
        'documentPaths', coalesce((select jsonb_agg(document_path) from leave_requests where user_id = v_user.id and document_path is not null), '[]'::jsonb),
        'avatarUrl', v_user.avatar_url
    );
end;
$function$;

revoke all on function public.prepare_prosm_time_self_deletion() from public, anon;
grant execute on function public.prepare_prosm_time_self_deletion() to authenticated;

-- the deletion itself (service role only, after the storage files are gone)
create or replace function public.anonymize_prosm_time_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user users%rowtype;
    v_owner uuid;
begin
    select * into v_user from users where id = p_user_id for update;
    if v_user.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if v_user.is_owner then raise exception 'THE OWNER ACCOUNT CANNOT BE DELETED THIS WAY'; end if;

    -- written first, while the name is still known
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, p_user_id, p_user_id, 'ACCOUNT_SELF_DELETED', 'users', p_user_id,
            'A person deleted their own account; their personal data was removed and their work records kept anonymised.');

    delete from location_samples where user_id = p_user_id;
    delete from camera_evidence where user_id = p_user_id;
    delete from push_devices where user_id = p_user_id;
    delete from signed_in_devices where user_id = p_user_id;
    delete from notifications where user_id = p_user_id;
    delete from dashboard_preferences where user_id = p_user_id;
    update leave_requests set document_path = null where user_id = p_user_id;

    update users
    set full_name = 'Deleted user ' || left(p_user_id::text, 8),
        email = 'deleted-' || p_user_id::text || '@deleted.invalid',
        avatar_url = null,
        hire_date = null,
        is_active = false,
        deactivated_at = now(),
        deactivation_reason = 'Account deleted by its user',
        updated_at = now()
    where id = p_user_id;

    -- the Owner hears of it
    select id into v_owner from users where organization_id = v_user.organization_id and is_owner and is_active limit 1;
    if v_owner is not null then
        perform public.create_prosm_time_notification(
            v_user.organization_id, v_owner, 'correction_submitted', 'normal', 'An employee deleted their account',
            v_user.full_name || ' deleted their account. Their attendance and timesheets are kept as "Deleted user".',
            'users', p_user_id, jsonb_build_object('kind', 'account_deleted', 'employeeName', v_user.full_name)
        );
    end if;

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.anonymize_prosm_time_user(uuid) from public, anon, authenticated;
grant execute on function public.anonymize_prosm_time_user(uuid) to service_role;

commit;
