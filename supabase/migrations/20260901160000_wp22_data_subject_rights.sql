-- PROSM Time Implementation Master File V3.0, WP-22 (Security
-- Hardening | §24: "Data subject rights: admin can export or delete an
-- individual employee's personal attendance data on request, subject
-- to legal/retention holds.") No prior WP built this - a real,
-- previously-missing capability, not a placeholder.
--
-- Retention hold policy (a real, bounded, documented interpretation -
-- §24 names the concept but not its exact rules): deletion is refused
-- while either holds:
--   (a) the employee has a timesheet that is currently submitted/
--       approved, OR was ever approved (approved_at is not null) -
--       payroll/legal records, the clearest real retention driver in
--       this domain;
--   (b) the employee has a currently open (clocked_in) attendance
--       session - deleting mid-shift data is operationally unsafe.
-- Export is never blocked by a hold - only deletion is.

begin;

-- ============================================================
-- Export - read-only, authenticated-callable directly (matches the
-- list_prosm_time_timesheet_evidence_pack precedent).
-- ============================================================

create or replace function public.export_prosm_time_employee_data(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target users%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_target.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'employees.manage_accounts' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO EXPORT THIS EMPLOYEE''S DATA';
    end if;

    return jsonb_build_object(
        'success', true,
        'employee', jsonb_build_object('id', v_target.id, 'fullName', v_target.full_name, 'email', v_target.email, 'status', v_target.status),
        'attendanceSessions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from attendance_sessions t where t.user_id = p_user_id),
        'attendanceEvents', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from attendance_events t where t.user_id = p_user_id),
        'presenceSessions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from presence_sessions t where t.user_id = p_user_id),
        'locationSamples', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from location_samples t where t.user_id = p_user_id),
        'sosAlerts', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from sos_alerts t where t.user_id = p_user_id),
        'geofenceExceptions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from geofence_exceptions t where t.user_id = p_user_id),
        'correctionRequests', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from correction_requests t where t.user_id = p_user_id),
        'breakEvents', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from break_events t where t.user_id = p_user_id),
        'cameraEvidence', (select coalesce(jsonb_agg(jsonb_build_object('id', ce.id, 'attendanceEventId', ce.attendance_event_id, 'contentType', ce.content_type, 'capturedAt', ce.captured_at)), '[]'::jsonb) from camera_evidence ce where ce.user_id = p_user_id),
        'notifications', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from notifications t where t.user_id = p_user_id),
        'deviceBindings', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from device_bindings t where t.user_id = p_user_id),
        'timesheets', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from timesheets t where t.user_id = p_user_id),
        'timesheetCorrections', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from timesheet_corrections t where t.requested_by = p_user_id),
        'adminOnBehalfActionsAsSubject', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from admin_on_behalf_actions t where t.subject_user_id = p_user_id),
        'siteAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from site_assignments t where t.user_id = p_user_id),
        'projectAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from project_assignments t where t.user_id = p_user_id)
    );
exception
    when others then
        raise exception 'EXPORT PROSM TIME EMPLOYEE DATA FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.export_prosm_time_employee_data(uuid) to authenticated;
revoke execute on function public.export_prosm_time_employee_data(uuid) from public, anon;

-- ============================================================
-- Deletion authorization + eligibility check - authenticated-callable
-- with the caller's own real permission check, run BEFORE any Edge
-- Function escalates to service role for the actual deletion.
-- ============================================================

create or replace function public.authorize_prosm_time_employee_data_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target users%rowtype;
    v_has_timesheet_hold boolean;
    v_has_open_session boolean;
    v_evidence jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_target.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'employees.manage_accounts' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO DELETE THIS EMPLOYEE''S DATA';
    end if;

    select exists (
        select 1 from timesheets where user_id = p_user_id and (status in ('submitted', 'approved') or approved_at is not null)
    ) into v_has_timesheet_hold;

    select exists (
        select 1 from attendance_sessions where user_id = p_user_id and status = 'clocked_in'
    ) into v_has_open_session;

    if v_has_timesheet_hold then
        return jsonb_build_object('success', true, 'authorized', false, 'callerUserId', v_caller_id, 'reason', 'This employee has a submitted, approved, or previously-approved timesheet - retained per legal/payroll requirements.');
    end if;

    if v_has_open_session then
        return jsonb_build_object('success', true, 'authorized', false, 'callerUserId', v_caller_id, 'reason', 'This employee is currently clocked in - clock them out before deleting their data.');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', ce.id, 'storagePath', ce.storage_path)), '[]'::jsonb)
    into v_evidence
    from camera_evidence ce
    where ce.user_id = p_user_id;

    return jsonb_build_object('success', true, 'authorized', true, 'callerUserId', v_caller_id, 'evidence', v_evidence);
exception
    when others then
        raise exception 'AUTHORIZE PROSM TIME EMPLOYEE DATA DELETION FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.authorize_prosm_time_employee_data_deletion(uuid) to authenticated;
revoke execute on function public.authorize_prosm_time_employee_data_deletion(uuid) from public, anon;

-- ============================================================
-- Actual deletion - service_role-only (mirrors the WP-08
-- delete_prosm_time_camera_evidence_record pattern exactly): the Edge
-- Function calls authorize_prosm_time_employee_data_deletion() first
-- with the caller's own JWT, then escalates to service_role only for
-- this step, after removing the evidence storage objects it was told
-- about. Re-checks the same retention holds defensively (race-
-- condition safety) even though authorization already happened.
-- ============================================================

create or replace function public.delete_prosm_time_employee_data(
    p_user_id uuid,
    p_actor_user_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_target users%rowtype;
    v_has_timesheet_hold boolean;
    v_has_open_session boolean;
begin
    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'A REASON IS REQUIRED';
    end if;

    select * into v_target from users where id = p_user_id;
    if v_target.id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    select exists (
        select 1 from timesheets where user_id = p_user_id and (status in ('submitted', 'approved') or approved_at is not null)
    ) into v_has_timesheet_hold;
    if v_has_timesheet_hold then
        raise exception 'RETENTION HOLD: THIS EMPLOYEE HAS A SUBMITTED, APPROVED, OR PREVIOUSLY-APPROVED TIMESHEET';
    end if;

    select exists (
        select 1 from attendance_sessions where user_id = p_user_id and status = 'clocked_in'
    ) into v_has_open_session;
    if v_has_open_session then
        raise exception 'THIS EMPLOYEE IS CURRENTLY CLOCKED IN';
    end if;

    -- admin_on_behalf_actions.session_id/event_id reference attendance_
    -- sessions/attendance_events with ON DELETE RESTRICT (§10's own
    -- distinct-actor/subject audit trail is never silently cascade-
    -- deleted by an unrelated FK) - deleted explicitly first so the
    -- attendance_sessions delete below does not hit that RESTRICT.
    delete from admin_on_behalf_actions where subject_user_id = p_user_id;

    -- Cascades to: attendance_events, presence_sessions -> location_samples/
    -- sos_alerts, camera_evidence (DB rows only - storage objects are
    -- removed by the caller before this function runs), geofence_exceptions
    -- -> exception_actions, correction_requests -> exception_actions,
    -- break_events.
    delete from attendance_sessions where user_id = p_user_id;

    delete from notifications where user_id = p_user_id;
    delete from device_bindings where user_id = p_user_id;

    -- No retention hold applies here (already verified above) -
    -- cascades to timesheet_approvals/timesheet_corrections.
    delete from timesheets where user_id = p_user_id;

    update users set kiosk_pin_hash = null where id = p_user_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_target.organization_id, p_actor_user_id, p_user_id, 'EMPLOYEE_DATA_DELETED', 'users', p_user_id, 'Employee personal attendance data deleted on request (§24 data subject rights).', p_reason);

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DELETE PROSM TIME EMPLOYEE DATA FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.delete_prosm_time_employee_data(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_prosm_time_employee_data(uuid, uuid, text) to service_role;

commit;
