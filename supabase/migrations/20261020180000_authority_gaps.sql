-- Workflow audit, owner 2026-10-20 (no incomplete workflow, security first).
-- Four functions were written before the authority rule of 20261019110000
-- ("only people below you, at sites you manage") and never picked it up:
--
-- C1. approve_prosm_time_timesheet - a manager could approve their own
--     timesheet, or a fellow manager's at a shared site.
-- C2. approve_prosm_time_allowance_entry - the same; also a rejection
--     silently turned the entry back into a draft with no reason kept, and
--     nobody was told anything: not the approvers when an employee
--     submitted, not the employee when it was decided.
-- C3. admin_clock_in_prosm_time_attendance - a manager could clock someone
--     in on their behalf at a site the manager does not manage.
-- I10. assign_prosm_time_shift - a manager could schedule a fellow manager,
--     or schedule someone on a day of their approved leave.
-- M3. admin_clock_out_prosm_time_attendance refused every shift clocked in
--     away from a site, so nobody but the Owner could close it.
--
-- Reviewer notes now travel to the employee in the notification's data
-- (the app shows them under the decision).

begin;

-- ============================================================
-- Notification types for allowances.
-- ============================================================

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected']));

-- The reviewer's decision is kept on the entry, so the employee sees why.
alter table public.allowance_entries add column if not exists reviewed_by uuid references public.users(id) on delete set null;
alter table public.allowance_entries add column if not exists reviewed_at timestamptz;
alter table public.allowance_entries add column if not exists review_notes text;

-- ============================================================
-- Who may decide for a person: the Owner, or someone holding the permission
-- who ranks above them and manages one of their sites (people with no site:
-- whoever holds people.unassigned). Same rule as the caller-side
-- prosm_time_caller_has_authority_over, evaluated for each recipient.
-- ============================================================

create or replace function public.notify_prosm_time_approvers_of(
    p_subject_user_id uuid,
    p_permission text,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null,
    p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_approver record;
begin
    select organization_id into v_org from users where id = p_subject_user_id;
    if v_org is null then return; end if;

    for v_approver in
        select u.id from users u
        where u.organization_id = v_org
          and u.is_active
          and u.id <> p_subject_user_id
          and public.prosm_time_user_has_permission_internal(u.id, p_permission)
          and (
              u.is_owner
              or (
                  public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_subject_user_id)
                  and (
                      exists (
                          select 1 from site_assignments msa
                          join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = p_subject_user_id
                          where msa.user_id = u.id and msa.role_at_site = 'manager'
                      )
                      or (
                          not exists (select 1 from site_assignments sa where sa.user_id = p_subject_user_id)
                          and public.prosm_time_user_has_permission_internal(u.id, 'people.unassigned')
                      )
                  )
              )
          )
    loop
        perform public.create_prosm_time_notification(v_org, v_approver.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke all on function public.notify_prosm_time_approvers_of(uuid, text, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- ============================================================
-- C1. Timesheet approval.
-- ============================================================

create or replace function public.approve_prosm_time_timesheet(
    p_timesheet_id uuid,
    p_action text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
    v_notes text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    -- Never your own, never a peer's: only someone ranked below you at a site you manage.
    if not (
        v_timesheet.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                public.prosm_time_user_has_permission_internal(v_caller_id, 'timesheets.approve')
                and public.prosm_time_caller_has_authority_over(v_timesheet.user_id)
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO APPROVE THIS TIMESHEET';
    end if;

    if v_timesheet.status <> 'submitted' then raise exception 'THIS TIMESHEET IS NOT AWAITING APPROVAL'; end if;

    v_notes := nullif(trim(coalesce(p_notes, '')), '');

    if p_action = 'approved' then
        update timesheets set status = 'approved', approved_by = v_caller_id, approved_at = now(), locked_at = now(), updated_at = now() where id = p_timesheet_id;
    else
        update timesheets set status = 'draft', submitted_at = null, updated_at = now() where id = p_timesheet_id;
    end if;

    insert into timesheet_approvals (organization_id, timesheet_id, actor_user_id, action, notes)
    values (v_timesheet.organization_id, p_timesheet_id, v_caller_id, p_action, v_notes);

    perform public.create_prosm_time_notification(
        v_timesheet.organization_id, v_timesheet.user_id,
        case when p_action = 'approved' then 'timesheet_approved' else 'timesheet_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Timesheet approved' else 'Timesheet rejected' end,
        coalesce(v_notes, case when p_action = 'approved' then 'Your timesheet was approved and is now locked.' else 'Your timesheet was rejected and returned to draft.' end),
        'timesheet', p_timesheet_id,
        jsonb_build_object('periodStart', v_timesheet.period_start, 'periodEnd', v_timesheet.period_end)
            || case when v_notes is not null then jsonb_build_object('notes', v_notes) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true, 'timesheetId', p_timesheet_id, 'status', p_action);
exception
    when others then
        raise exception 'APPROVE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- C2. Allowances: submit tells the approvers; the decision is kept on the
-- entry and told to the employee; only someone with authority decides.
-- ============================================================

create or replace function public.submit_prosm_time_allowance_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_entry allowance_entries%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_entry from allowance_entries where id = p_entry_id;
    if v_entry.id is null then
        raise exception 'ALLOWANCE ENTRY NOT FOUND';
    end if;

    if v_entry.user_id <> v_caller_id then
        raise exception 'YOU MAY ONLY SUBMIT YOUR OWN ALLOWANCE ENTRY';
    end if;

    -- A rejected entry can be sent again (after fixing it, or as it is with an explanation).
    if v_entry.status not in ('draft', 'rejected') then
        raise exception 'THIS ALLOWANCE ENTRY IS NOT IN DRAFT STATUS';
    end if;

    update allowance_entries set status = 'submitted', submitted_at = now(), updated_at = now() where id = p_entry_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_entry.organization_id, v_caller_id, 'ALLOWANCE_ENTRY_SUBMITTED', 'allowance_entries', p_entry_id, 'Allowance entry for ' || v_entry.entry_date || ' submitted.');

    perform public.notify_prosm_time_approvers_of(
        v_caller_id, 'allowances.approve', 'allowance_submitted', 'normal',
        'Allowances waiting for approval',
        (select full_name from users where id = v_caller_id) || ' submitted allowances for ' || v_entry.entry_date || '.',
        'allowance_entries', p_entry_id,
        jsonb_build_object('employeeName', (select full_name from users where id = v_caller_id), 'entryDate', v_entry.entry_date)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.approve_prosm_time_allowance_entry(
    p_entry_id uuid,
    p_action text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_entry allowance_entries%rowtype;
    v_site_id uuid;
    v_notes text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;

    select * into v_entry from allowance_entries where id = p_entry_id and organization_id = v_caller_org;
    if v_entry.id is null then
        raise exception 'ALLOWANCE ENTRY NOT FOUND';
    end if;

    if v_entry.status <> 'submitted' then
        raise exception 'THIS ALLOWANCE ENTRY IS NOT AWAITING APPROVAL';
    end if;

    -- The day's shift decides the site (the site responsible for it when it
    -- was clocked in away from a site); with no shift, the person's sites.
    select coalesce(ats.site_id, ats.responsible_site_id) into v_site_id
    from attendance_sessions ats where ats.id = v_entry.attendance_session_id;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            public.prosm_time_user_has_permission_internal(v_caller_id, 'allowances.approve')
            and public.prosm_time_caller_has_authority_over(v_entry.user_id, v_site_id)
        )
    ) then
        raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED FOR THIS EMPLOYEE';
    end if;

    v_notes := nullif(trim(coalesce(p_notes, '')), '');

    if p_action = 'approved' then
        update allowance_entries
        set status = 'approved', approved_by = v_caller_id, approved_at = now(),
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = v_notes, updated_at = now()
        where id = p_entry_id;
    else
        -- Rejected stays rejected (with the reason) until the employee edits or resubmits it.
        update allowance_entries
        set status = 'rejected', reviewed_by = v_caller_id, reviewed_at = now(), review_notes = v_notes, updated_at = now()
        where id = p_entry_id;
    end if;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_entry.user_id, 'ALLOWANCE_ENTRY_' || upper(p_action), 'allowance_entries', p_entry_id,
        'Allowance entry for ' || v_entry.entry_date || ' ' || p_action || '.', v_notes
    );

    perform public.create_prosm_time_notification(
        v_caller_org, v_entry.user_id,
        case when p_action = 'approved' then 'allowance_approved' else 'allowance_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Allowances approved' else 'Allowances rejected' end,
        coalesce(v_notes, 'Your allowances for ' || v_entry.entry_date || ' were ' || p_action || '.'),
        'allowance_entries', p_entry_id,
        jsonb_build_object('entryDate', v_entry.entry_date)
            || case when v_notes is not null then jsonb_build_object('notes', v_notes) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'APPROVE PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- C3 / M3. On-behalf clock-in and clock-out.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_clock_in_prosm_time_attendance(p_subject_user_id uuid, p_site_id uuid, p_reason text, p_project_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_idempotency_key text;
    v_audit_log_id uuid;
    v_action_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_in_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_IN_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    -- Audit 4.4 - only people below the caller's own role (the Owner: anyone).
    if not (public.current_prosm_time_user_is_owner() or public.current_prosm_time_user_role_key() = 'manager') then
        raise exception 'ONLY THE OWNER OR A MANAGER MAY ACT ON SOMEONE ELSES BEHALF';
    end if;

    if not public.prosm_time_can_act_on_behalf_of(v_caller_id, p_subject_user_id) then
        raise exception 'YOU CAN ONLY ACT ON BEHALF OF PEOPLE BELOW YOUR ROLE';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-in-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    -- § real gap fix, user-reported 2026-09-15 - same block as self
    -- clock-in (20260910110000). Placed after the idempotency-replay
    -- check for the same reason: a replay of an already-succeeded
    -- clock-in must still succeed.
    if exists (
        select 1 from leave_requests
        where user_id = p_subject_user_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE TODAY';
    end if;

    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active = true) then
        raise exception 'SITE NOT FOUND';
    end if;

    -- Workflow audit C3 (owner 2026-10-20): a manager acts only at a site they manage.
    if not public.prosm_time_caller_has_authority_over(p_subject_user_id, p_site_id) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    if not public.current_prosm_time_user_is_owner() and not exists (
        select 1 from site_assignments where site_id = p_site_id and user_id = p_subject_user_id
    ) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = p_subject_user_id) then
            raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'THIS EMPLOYEE IS ALREADY CLOCKED IN';
    end if;

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, p_subject_user_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_session_id, p_subject_user_id, 'clock_in', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_IN_ON_BEHALF', 'attendance_sessions', v_session_id,
        v_subject.full_name || ' clocked in by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('siteId', p_site_id, 'projectId', p_project_id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_in', v_session_id, v_event_id,
        p_reason, 'not_clocked_in', 'clocked_in', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK IN ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_clock_out_prosm_time_attendance(p_subject_user_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_device_info text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_subject users%rowtype;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_event_id uuid;
    v_idempotency_key text;
    v_audit_log_id uuid;
    v_action_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_subject from users where id = p_subject_user_id and organization_id = v_caller_org;
    if v_subject.id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    -- Audit 4.4 - only people below the caller's own role (the Owner: anyone).
    if not (public.current_prosm_time_user_is_owner() or public.current_prosm_time_user_role_key() = 'manager') then
        raise exception 'ONLY THE OWNER OR A MANAGER MAY ACT ON SOMEONE ELSES BEHALF';
    end if;

    if not public.prosm_time_can_act_on_behalf_of(v_caller_id, p_subject_user_id) then
        raise exception 'YOU CAN ONLY ACT ON BEHALF OF PEOPLE BELOW YOUR ROLE';
    end if;

    v_idempotency_key := coalesce(p_idempotency_key, 'admin-clock-out-' || gen_random_uuid()::text);

    select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_open_session from attendance_sessions where user_id = p_subject_user_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'THIS EMPLOYEE IS NOT CURRENTLY CLOCKED IN';
    end if;

    -- Workflow audit M3 (owner 2026-10-20): a shift clocked in away from
    -- every site is judged by the site responsible for it, or - with no
    -- site at all - by the caller's authority over the person.
    if not public.prosm_time_caller_has_authority_over(p_subject_user_id, coalesce(v_open_session.site_id, v_open_session.responsible_site_id)) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, latitude, longitude, accuracy_meters, idempotency_key, recorded_by
    ) values (
        v_open_session.id, p_subject_user_id, 'clock_out', now(), p_latitude, p_longitude, p_accuracy_meters, v_idempotency_key, v_caller_id
    )
    returning id into v_event_id;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    -- § the actual fix - this UPDATE was missing entirely before today,
    -- the one gap between this function and the regular self-service
    -- clock_out_prosm_time_attendance, which always had it.
    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_subject_user_id, 'ADMIN_CLOCK_OUT_ON_BEHALF', 'attendance_sessions', v_open_session.id,
        v_subject.full_name || ' clocked out by ' || (select full_name from users where id = v_caller_id) || ' on their behalf.',
        p_reason, jsonb_build_object('sessionId', v_open_session.id)
    )
    returning id into v_audit_log_id;

    insert into admin_on_behalf_actions (
        organization_id, actor_user_id, subject_user_id, action_type, session_id, event_id,
        reason, original_state, resulting_state, latitude, longitude, accuracy_meters, device_info, audit_log_id
    ) values (
        v_caller_org, v_caller_id, p_subject_user_id, 'clock_out', v_open_session.id, v_event_id,
        p_reason, 'clocked_in', 'clocked_out', p_latitude, p_longitude, p_accuracy_meters, p_device_info, v_audit_log_id
    )
    returning id into v_action_id;

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'actionId', v_action_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = p_subject_user_id and idempotency_key = v_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
    when others then
        raise exception 'ADMIN CLOCK OUT ON BEHALF FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- I10. Scheduling: only people below you, and never on their leave.
-- ============================================================

create or replace function public.assign_prosm_time_shift(
    p_user_id uuid,
    p_site_id uuid,
    p_shift_date date,
    p_start_time time,
    p_end_time time,
    p_shift_template_id uuid default null,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_assignment_id uuid;
    v_has_overlap boolean;
    v_new_start timestamp;
    v_new_end timestamp;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO ASSIGN SHIFTS';
    end if;
    if not public.current_prosm_time_user_is_owner() and not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;
    if p_end_time = p_start_time then
        raise exception 'END TIME MUST BE DIFFERENT FROM START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    if not public.prosm_time_caller_has_authority_over(p_user_id, p_site_id) then
        raise exception 'YOU CAN ONLY SCHEDULE PEOPLE BELOW YOUR ROLE';
    end if;

    if exists (
        select 1 from leave_requests
        where user_id = p_user_id and status = 'approved'
          and p_shift_date between start_date and end_date
    ) then
        raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE ON THIS DATE';
    end if;

    v_new_start := p_shift_date + p_start_time;
    v_new_end := p_shift_date + p_end_time + (case when p_end_time <= p_start_time then interval '1 day' else interval '0' end);

    select exists (
        select 1 from shift_assignments sa
        where sa.user_id = p_user_id and sa.status = 'scheduled'
          and sa.shift_date between p_shift_date - 1 and p_shift_date + 1
          and v_new_start < (sa.shift_date + sa.end_time + (case when sa.end_time <= sa.start_time then interval '1 day' else interval '0' end))
          and v_new_end > (sa.shift_date + sa.start_time)
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE';
    end if;

    insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time, notes, created_by)
    values (v_org, p_user_id, p_site_id, p_shift_template_id, p_shift_date, p_start_time, p_end_time, nullif(trim(coalesce(p_notes, '')), ''), v_caller_id)
    returning id into v_assignment_id;

    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'shift_assigned', 'normal', 'A new shift was scheduled for you',
        'You are scheduled on ' || p_shift_date::text || ' from ' || p_start_time::text || ' to ' || p_end_time::text ||
            (case when p_end_time <= p_start_time then ' (next day)' else '' end) || '.',
        'shift_assignments', v_assignment_id,
        jsonb_build_object('shiftDate', p_shift_date, 'startTime', p_start_time, 'endTime', p_end_time, 'crossesMidnight', p_end_time <= p_start_time)
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'ASSIGN PROSM TIME SHIFT FAILED: %', sqlerrm;
end;
$function$;

commit;
