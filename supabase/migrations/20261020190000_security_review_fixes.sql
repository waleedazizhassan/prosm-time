-- Security review, owner 2026-10-20 ("security is the most important thing").
-- Each sensitive function below keeps its body; it is renamed to *_unchecked
-- (callable by nobody but the database) and a same-named front door checks
-- the caller first, so the existing apps and edge functions keep working.
--
-- H1. Kiosk clock-in/out could be called straight from the API by any
--     employee: unlimited PIN guessing of a coworker, and a clock-in from
--     anywhere recorded at the site's own coordinates. Now only the Owner or
--     a manager of that site (the kiosk runs on their session) may operate
--     it, and who operated it is written to the audit log.
-- H2. Kiosk PIN hashes were readable through the users table. The column
--     is no longer selectable by app users.
-- H3. Camera photos in storage were readable org-wide by attendance.view;
--     now the same site scope as the photo records themselves.
-- H4. GPS trails (location_samples) and location plausibility flags were
--     readable org-wide; now the same site scope as presence sessions.
-- M1. A site manager could remove a fellow manager (or the Owner) from the
--     site; now only people ranked below them.
-- M2. Kiosk PIN reset, personal-data export and deletion and device
--     approval reached anyone in the organisation, the Owner included; now
--     only people below the caller at sites they manage (the Owner: anyone).
--     PIN resets and exports are audited.
-- L4. Device bindings were visible to every member; now to the person and
--     those who manage their account.

begin;

-- ============================================================
-- Front doors.
-- ============================================================

alter function public.kiosk_clock_in_prosm_time_attendance(uuid, uuid, text, text, uuid, timestamptz) rename to kiosk_clock_in_prosm_time_attendance_unchecked;
alter function public.kiosk_clock_out_prosm_time_attendance(uuid, uuid, text, text, timestamptz) rename to kiosk_clock_out_prosm_time_attendance_unchecked;
alter function public.admin_set_prosm_time_kiosk_pin(uuid, text) rename to admin_set_prosm_time_kiosk_pin_unchecked;
alter function public.export_prosm_time_employee_data(uuid) rename to export_prosm_time_employee_data_unchecked;
alter function public.authorize_prosm_time_employee_data_deletion(uuid) rename to authorize_prosm_time_employee_data_deletion_unchecked;
alter function public.set_prosm_time_device_binding_status(uuid, text, text) rename to set_prosm_time_device_binding_status_unchecked;
alter function public.remove_prosm_time_site_assignment(uuid, uuid) rename to remove_prosm_time_site_assignment_unchecked;

revoke all on function public.kiosk_clock_in_prosm_time_attendance_unchecked(uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.kiosk_clock_out_prosm_time_attendance_unchecked(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_set_prosm_time_kiosk_pin_unchecked(uuid, text) from public, anon, authenticated;
revoke all on function public.export_prosm_time_employee_data_unchecked(uuid) from public, anon, authenticated;
revoke all on function public.authorize_prosm_time_employee_data_deletion_unchecked(uuid) from public, anon, authenticated;
revoke all on function public.set_prosm_time_device_binding_status_unchecked(uuid, text, text) from public, anon, authenticated;
revoke all on function public.remove_prosm_time_site_assignment_unchecked(uuid, uuid) from public, anon, authenticated;

-- The kiosk is operated by the Owner or a manager of the site.
create or replace function public.prosm_time_caller_operates_kiosk(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select public.current_prosm_time_user_id() is not null
       and exists (select 1 from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id())
       and (
           public.current_prosm_time_user_is_owner()
           or (public.current_prosm_time_user_role_key() = 'manager' and p_site_id = any(public.current_prosm_time_managed_site_ids()))
       );
$function$;

revoke all on function public.prosm_time_caller_operates_kiosk(uuid) from public, anon, authenticated;

create function public.kiosk_clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_employee_user_id uuid,
    p_pin text,
    p_idempotency_key text,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    if not public.prosm_time_caller_operates_kiosk(p_site_id) then
        raise exception 'KIOSK CLOCK IN FAILED: ONLY THE OWNER OR A MANAGER OF THIS SITE MAY OPERATE ITS KIOSK';
    end if;
    v_result := public.kiosk_clock_in_prosm_time_attendance_unchecked(p_site_id, p_employee_user_id, p_pin, p_idempotency_key, p_project_id, p_client_reported_at);
    if coalesce((v_result ->> 'replay')::boolean, false) is false then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
        values (public.current_prosm_time_organization_id(), public.current_prosm_time_user_id(), p_employee_user_id, 'KIOSK_CLOCK_IN_OPERATED',
                'attendance_sessions', nullif(v_result ->> 'sessionId', '')::uuid, 'Kiosk clock-in operated.', jsonb_build_object('siteId', p_site_id));
    end if;
    return v_result;
end;
$function$;

create function public.kiosk_clock_out_prosm_time_attendance(
    p_site_id uuid,
    p_employee_user_id uuid,
    p_pin text,
    p_idempotency_key text,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    if not public.prosm_time_caller_operates_kiosk(p_site_id) then
        raise exception 'KIOSK CLOCK OUT FAILED: ONLY THE OWNER OR A MANAGER OF THIS SITE MAY OPERATE ITS KIOSK';
    end if;
    v_result := public.kiosk_clock_out_prosm_time_attendance_unchecked(p_site_id, p_employee_user_id, p_pin, p_idempotency_key, p_client_reported_at);
    if coalesce((v_result ->> 'replay')::boolean, false) is false then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
        values (public.current_prosm_time_organization_id(), public.current_prosm_time_user_id(), p_employee_user_id, 'KIOSK_CLOCK_OUT_OPERATED',
                'attendance_sessions', nullif(v_result ->> 'sessionId', '')::uuid, 'Kiosk clock-out operated.', jsonb_build_object('siteId', p_site_id));
    end if;
    return v_result;
end;
$function$;

create function public.admin_set_prosm_time_kiosk_pin(p_user_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    if not public.prosm_time_caller_has_authority_over(p_user_id) then
        raise exception 'ADMIN SET KIOSK PIN FAILED: YOU CAN ONLY SET THE PIN OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE';
    end if;
    v_result := public.admin_set_prosm_time_kiosk_pin_unchecked(p_user_id, p_pin);
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (public.current_prosm_time_organization_id(), public.current_prosm_time_user_id(), p_user_id, 'KIOSK_PIN_SET_BY_ADMIN', 'users', p_user_id, 'Kiosk PIN set by an administrator.');
    return v_result;
end;
$function$;

create function public.export_prosm_time_employee_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_result jsonb;
begin
    if not public.prosm_time_caller_has_authority_over(p_user_id) then
        raise exception 'EXPORT EMPLOYEE DATA FAILED: YOU ARE NOT AUTHORIZED TO EXPORT THIS EMPLOYEE''S DATA';
    end if;
    v_result := public.export_prosm_time_employee_data_unchecked(p_user_id);
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (public.current_prosm_time_organization_id(), public.current_prosm_time_user_id(), p_user_id, 'EMPLOYEE_DATA_EXPORTED', 'users', p_user_id, 'Personal data exported.');
    return v_result;
end;
$function$;

create function public.authorize_prosm_time_employee_data_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    -- The Owner's own data is never deleted this way (it would orphan the organisation).
    if exists (select 1 from users where id = p_user_id and is_owner)
       or not public.prosm_time_caller_has_authority_over(p_user_id) then
        raise exception 'AUTHORIZE EMPLOYEE DATA DELETION FAILED: YOU ARE NOT AUTHORIZED TO DELETE THIS EMPLOYEE''S DATA';
    end if;
    return public.authorize_prosm_time_employee_data_deletion_unchecked(p_user_id);
end;
$function$;

create function public.set_prosm_time_device_binding_status(p_device_binding_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user uuid;
begin
    select user_id into v_user from device_bindings where id = p_device_binding_id;
    if v_user is null or not public.prosm_time_caller_has_authority_over(v_user) then
        raise exception 'SET DEVICE BINDING STATUS FAILED: YOU CAN ONLY MANAGE DEVICES OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE';
    end if;
    return public.set_prosm_time_device_binding_status_unchecked(p_device_binding_id, p_status, p_reason);
end;
$function$;

create function public.remove_prosm_time_site_assignment(p_site_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if not public.prosm_time_caller_has_authority_over(p_user_id, p_site_id) then
        raise exception 'REMOVE SITE ASSIGNMENT FAILED: YOU CAN ONLY REMOVE PEOPLE BELOW YOUR ROLE FROM A SITE YOU MANAGE';
    end if;
    return public.remove_prosm_time_site_assignment_unchecked(p_site_id, p_user_id);
end;
$function$;

revoke all on function public.kiosk_clock_in_prosm_time_attendance(uuid, uuid, text, text, uuid, timestamptz) from public, anon;
revoke all on function public.kiosk_clock_out_prosm_time_attendance(uuid, uuid, text, text, timestamptz) from public, anon;
revoke all on function public.admin_set_prosm_time_kiosk_pin(uuid, text) from public, anon;
revoke all on function public.export_prosm_time_employee_data(uuid) from public, anon;
revoke all on function public.authorize_prosm_time_employee_data_deletion(uuid) from public, anon;
revoke all on function public.set_prosm_time_device_binding_status(uuid, text, text) from public, anon;
revoke all on function public.remove_prosm_time_site_assignment(uuid, uuid) from public, anon;
grant execute on function public.kiosk_clock_in_prosm_time_attendance(uuid, uuid, text, text, uuid, timestamptz) to authenticated;
grant execute on function public.kiosk_clock_out_prosm_time_attendance(uuid, uuid, text, text, timestamptz) to authenticated;
grant execute on function public.admin_set_prosm_time_kiosk_pin(uuid, text) to authenticated;
grant execute on function public.export_prosm_time_employee_data(uuid) to authenticated;
grant execute on function public.authorize_prosm_time_employee_data_deletion(uuid) to authenticated;
grant execute on function public.set_prosm_time_device_binding_status(uuid, text, text) to authenticated;
grant execute on function public.remove_prosm_time_site_assignment(uuid, uuid) to authenticated;

-- ============================================================
-- H2. PIN hashes are never readable by app users.
-- ============================================================

revoke select on public.users from authenticated;
do $$
declare
    v_columns text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_columns
    from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name <> 'kiosk_pin_hash';
    execute format('grant select (%s) on public.users to authenticated', v_columns);
end;
$$;

-- ============================================================
-- H3. Camera photos in storage: the photo record's own scope.
-- ============================================================

drop policy if exists "event subject, on-behalf actor, or attendance.view can read camera evidence" on storage.objects;
create policy "event subject, on-behalf actor, or attendance.view can read camera evidence"
on storage.objects for select to authenticated
using (
    bucket_id = 'camera-evidence'
    and (storage.foldername(name))[1] = 'attendance-events'
    and exists (
        select 1 from public.attendance_events e
        join public.attendance_sessions s on s.id = e.session_id
        where e.id::text = (storage.foldername(name))[2]
        and (
            e.user_id = public.current_prosm_time_user_id()
            or e.recorded_by = public.current_prosm_time_user_id()
            or (
                s.organization_id = public.current_prosm_time_organization_id()
                and (
                    public.current_prosm_time_user_is_owner()
                    or (
                        'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                        and (coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
                    )
                )
            )
        )
    )
);

-- ============================================================
-- H4. GPS trails and plausibility flags: the presence session's scope.
-- ============================================================

drop policy if exists "location samples visible to subject or attendance.view" on public.location_samples;
create policy "location samples visible to subject or attendance.view"
on public.location_samples for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or exists (
        select 1 from presence_sessions ps
        where ps.id = location_samples.presence_session_id
        and ps.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (ps.site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

drop policy if exists "location plausibility flags visible to subject or attendance.view" on public.location_plausibility_flags;
create policy "location plausibility flags visible to subject or attendance.view"
on public.location_plausibility_flags for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (
                    site_id = any(public.current_prosm_time_managed_site_ids())
                    or public.current_prosm_time_user_role_key() = 'read_only'
                    or (site_id is null and public.prosm_time_caller_sees_person(user_id))
                )
            )
        )
    )
);

-- ============================================================
-- L4. Device bindings: the person, and those who manage their account.
-- ============================================================

drop policy if exists "members can view device bindings in own organization" on public.device_bindings;
create policy "device bindings visible to the person or their account managers"
on public.device_bindings for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        user_id in (select id from users where organization_id = public.current_prosm_time_organization_id())
        and public.prosm_time_caller_has_authority_over(user_id)
        and (
            public.current_prosm_time_user_is_owner()
            or 'employees.manage_accounts' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

commit;
