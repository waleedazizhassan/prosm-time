-- PROSM Time - user-reported real gap (#6, 2026-09-15): "كشف الدوام
-- لما بيصدر PDF، الاجازات مش بتتسجل فيه - عايز كل التفاصيل." The
-- timesheet already has a real total_leave_days column (computed at
-- generation time) and real per-request leave_requests rows exist for
-- the same period - neither was ever threaded through
-- list_prosm_time_timesheet_evidence_pack (the RPC the PDF/report page
-- reads from), so the printed document never showed either. Same
-- overlapping-window logic already established for leave elsewhere in
-- this codebase (export-leave/timesheet generation itself).

begin;

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
    v_leave_entries jsonb;
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

    -- § real gap fix, 2026-09-15 - leave for this period never made it
    -- into the pack at all. Overlapping-window logic (a leave spanning
    -- into or out of the period still counts), same as this codebase's
    -- own export-leave/generate-timesheet.
    select coalesce(jsonb_agg(row order by row->>'startDate'), '[]'::jsonb) into v_leave_entries
    from (
        select jsonb_build_object(
            'id', lr.id, 'leaveType', lr.leave_type, 'startDate', lr.start_date, 'endDate', lr.end_date,
            'daysCount', lr.days_count, 'status', lr.status, 'reason', lr.reason
        ) as row
        from leave_requests lr
        where lr.user_id = v_timesheet.user_id
        and lr.status = 'approved'
        and lr.start_date <= v_timesheet.period_end
        and lr.end_date >= v_timesheet.period_start
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
            'totalLeaveDays', v_timesheet.total_leave_days,
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
        'timesheetCorrections', v_timesheet_corrections,
        'leaveEntries', v_leave_entries
    );
exception
    when others then
        raise exception 'LIST PROSM TIME TIMESHEET EVIDENCE PACK FAILED: %', sqlerrm;
end;
$function$;

commit;
