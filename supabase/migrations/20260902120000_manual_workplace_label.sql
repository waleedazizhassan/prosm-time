-- PROSM Time - explicit user-directed correction: the earlier
-- "activation site name" fix (20260902110000) only guarantees the
-- ORGANIZATION has one real site to pick from - it does nothing for
-- the moment an employee actually clocks in with "No site" selected
-- (a real, deliberate capability, 20260901180000: "they may be
-- working somewhere not registered as a work site"). That path had
-- nowhere at all to record WHERE they actually are, which is the
-- real reason the PDF/Attendance Record still shows a blank site for
-- those sessions. User's own words: "افرض مسجل دخول ومش مختار موقع
-- من القايمة، اكتب فيها اسم المكان" - a free-text "workplace" field
-- for exactly that case, and explicitly required, not optional
-- ("ميقبلش تسجيل غير لما اكتب اسم مكان العمل").
--
-- attendance_sessions gets one new nullable column, only ever
-- populated when site_id is null; clock_in_prosm_time_attendance now
-- requires it in that case (raises, same posture as every other
-- required-field check already in this function) and stores it.
-- Every report surface that already displays "siteName" (Manager
-- Console, Attendance Record, its PDF, the Timesheet evidence pack/
-- PDF) is updated to fall back to this label instead of showing
-- blank - a real site's name always wins when one exists.

begin;

alter table public.attendance_sessions add column manual_location_label text;

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
    v_exception_id uuid;
    v_manual_label text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
        end if;

        if p_project_id is not null then
            if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
                raise exception 'PROJECT NOT FOUND AT THIS SITE';
            end if;
            if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
                raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
            end if;
        end if;
    else
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', now(), v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            (select full_name from users where id = v_caller_id) || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false,
        'geofence', v_geofence, 'presenceSessionId', v_presence_session_id
    );
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) to authenticated;

-- Timesheet evidence pack / PDF - same fallback as Manager Console/
-- Attendance Record below, so a no-site entry in a certified PDF also
-- shows the employee's own workplace label instead of blank.
create or replace function public.list_prosm_time_timesheet_evidence_pack(p_timesheet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
    v_user users%rowtype;
    v_org organizations%rowtype;
    v_approver_name text;
    v_entries jsonb;
    v_exceptions jsonb;
    v_corrections jsonb;
    v_evidence jsonb;
    v_approval_trail jsonb;
    v_timesheet_corrections jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    if not (
        v_timesheet.user_id = v_caller_id
        or (
            v_timesheet.organization_id = public.current_prosm_time_organization_id()
            and (
                public.current_prosm_time_user_is_owner()
                or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'reports.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS TIMESHEET REPORT';
    end if;

    select * into v_user from users where id = v_timesheet.user_id;
    select * into v_org from organizations where id = v_timesheet.organization_id;
    select full_name into v_approver_name from users where id = v_timesheet.approved_by;

    select coalesce(jsonb_agg(entry order by entry->>'clockInAt'), '[]'::jsonb) into v_entries
    from (
        select jsonb_build_object(
            'sessionId', ats.id,
            'siteId', ats.site_id,
            'siteName', coalesce(s.name, ats.manual_location_label),
            'projectId', ats.project_id,
            'projectName', p.name,
            'clockInAt', ats.clock_in_at,
            'clockOutAt', ats.clock_out_at,
            'workedMinutes', extract(epoch from (coalesce(ats.clock_out_at, now()) - ats.clock_in_at)) / 60,
            'breakMinutes', coalesce((
                select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60)
                from break_events be where be.attendance_session_id = ats.id
            ), 0)
        ) as entry
        from attendance_sessions ats
        left join sites s on s.id = ats.site_id
        left join projects p on p.id = ats.project_id
        where ats.user_id = v_timesheet.user_id
        and ats.clock_in_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_exceptions
    from (
        select jsonb_build_object(
            'id', ge.id, 'distanceMeters', ge.distance_meters, 'reasonCategory', ge.reason_category,
            'employeeReason', ge.employee_reason, 'status', ge.status, 'createdAt', ge.created_at
        ) as row
        from geofence_exceptions ge
        where ge.user_id = v_timesheet.user_id and ge.created_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_corrections
    from (
        select jsonb_build_object(
            'id', cr.id, 'proposedEventType', cr.proposed_event_type, 'proposedCorrectTime', cr.proposed_correct_time,
            'reason', cr.reason, 'status', cr.status, 'createdAt', cr.created_at
        ) as row
        from correction_requests cr
        where cr.user_id = v_timesheet.user_id and cr.created_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'capturedAt'), '[]'::jsonb) into v_evidence
    from (
        select jsonb_build_object(
            'id', ce.id, 'attendanceEventId', ce.attendance_event_id, 'storagePath', ce.storage_path,
            'contentType', ce.content_type, 'capturedAt', ce.captured_at
        ) as row
        from camera_evidence ce
        join attendance_events ae on ae.id = ce.attendance_event_id
        where ae.user_id = v_timesheet.user_id and ae.occurred_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_approval_trail
    from (
        select jsonb_build_object(
            'action', ta.action, 'actorName', u.full_name, 'notes', ta.notes, 'createdAt', ta.created_at
        ) as row
        from timesheet_approvals ta
        join users u on u.id = ta.actor_user_id
        where ta.timesheet_id = p_timesheet_id
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_timesheet_corrections
    from (
        select jsonb_build_object(
            'id', tc.id, 'reason', tc.reason, 'status', tc.status, 'reviewNotes', tc.review_notes,
            'reviewedAt', tc.reviewed_at, 'createdAt', tc.created_at
        ) as row
        from timesheet_corrections tc
        where tc.timesheet_id = p_timesheet_id
    ) rows;

    return jsonb_build_object(
        'success', true,
        'timesheet', jsonb_build_object(
            'id', v_timesheet.id,
            'periodStart', v_timesheet.period_start,
            'periodEnd', v_timesheet.period_end,
            'status', v_timesheet.status,
            'totalWorkedMinutes', v_timesheet.total_worked_minutes,
            'totalBreakMinutes', v_timesheet.total_break_minutes,
            'totalOvertimeMinutes', v_timesheet.total_overtime_minutes,
            'submittedAt', v_timesheet.submitted_at,
            'approvedAt', v_timesheet.approved_at,
            'lockedAt', v_timesheet.locked_at,
            'approverName', v_approver_name
        ),
        'employee', jsonb_build_object('id', v_user.id, 'fullName', v_user.full_name, 'email', v_user.email),
        'organization', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'organizationCode', v_org.organization_code),
        'entries', v_entries,
        'exceptions', v_exceptions,
        'corrections', v_corrections,
        'evidenceReferences', v_evidence,
        'approvalTrail', v_approval_trail,
        'timesheetCorrections', v_timesheet_corrections
    );
exception
    when others then
        raise exception 'LIST PROSM TIME TIMESHEET EVIDENCE PACK FAILED: %', sqlerrm;
end;
$function$;

commit;
