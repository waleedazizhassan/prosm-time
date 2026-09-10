-- PROSM Time - Manager permissions/visibility technical audit (cont'd).
--
-- Same root cause as 20260910190000 (Reports Center), found in 3 more
-- places that were all built AFTER 20260902090000 established the
-- "a Manager's authority is scoped to current_prosm_time_managed_
-- site_ids(), not the whole org" convention, and never had it applied:
--
--   1. Leave requests - review_prosm_time_leave, and the leave_requests/
--      leave_entitlements SELECT policies, let anyone holding
--      'exceptions.manage' review/see EVERY employee's leave, org-wide.
--   2. Timesheet approval - approve_prosm_time_timesheet let anyone
--      holding 'timesheets.approve' approve ANY employee's timesheet,
--      org-wide.
--   3. Shift scheduling - assign_prosm_time_shift/cancel_prosm_time_
--      shift_assignment let anyone holding 'schedules.manage' schedule/
--      cancel shifts at ANY site, org-wide (shift_templates' own SELECT
--      policy is deliberately left alone - its own comment already
--      documents shift patterns as shared org-wide reference data, a
--      real, intentional design choice, not a gap).
--
-- sos_alerts was checked too and deliberately NOT touched here - SOS is
-- a safety/emergency feature; restricting an emergency alert's
-- visibility to "your site only" could delay a real response and is
-- the one place org-wide Manager visibility is the correct call, not a
-- leak.
--
-- Neither leave_requests nor timesheets carries a direct site_id column
-- (an employee isn't tied to one site the way an attendance_session
-- is) - scoped the same way list_prosm_time_visible_members() already
-- does: the request's/timesheet's own subject employee must have a
-- site_assignments row at one of the caller's managed sites.

begin;

drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or (
        'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        and exists (
            select 1 from site_assignments sa
            where sa.user_id = leave_requests.user_id
            and sa.site_id = any(public.current_prosm_time_managed_site_ids())
        )
    )
);

drop policy if exists "members can view own leave entitlements" on public.leave_entitlements;
create policy "members can view own leave entitlements"
on public.leave_entitlements for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or (
        'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        and exists (
            select 1 from site_assignments sa
            where sa.user_id = leave_entitlements.user_id
            and sa.site_id = any(public.current_prosm_time_managed_site_ids())
        )
    )
);

create or replace function public.review_prosm_time_leave(
    p_request_id uuid,
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
    v_org uuid;
    v_request leave_requests%rowtype;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;
    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;

    if not public.current_prosm_time_user_is_owner() and not exists (
        select 1 from site_assignments sa
        where sa.user_id = v_request.user_id
        and sa.site_id = any(public.current_prosm_time_managed_site_ids())
    ) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEE''S SITE';
    end if;

    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    if v_request.status = 'approved' and p_action = 'approved' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    update leave_requests
    set status = case when p_action = 'approved' then 'approved' else 'rejected' end,
        reviewed_by = v_caller_id, reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), ''),
        updated_at = now()
    where id = p_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.create_prosm_time_notification(
        v_org, v_request.user_id, 'correction_reviewed', 'normal', 'Your leave request was reviewed',
        'Decision: ' || p_action || '.', 'leave_requests', p_request_id,
        jsonb_build_object('kind', 'leave', 'actionType', p_action)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REVIEW PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

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
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    if not (
        v_timesheet.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and exists (
                    select 1 from site_assignments sa
                    where sa.user_id = v_timesheet.user_id
                    and sa.site_id = any(public.current_prosm_time_managed_site_ids())
                )
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO APPROVE THIS TIMESHEET';
    end if;

    if v_timesheet.status <> 'submitted' then raise exception 'THIS TIMESHEET IS NOT AWAITING APPROVAL'; end if;

    if p_action = 'approved' then
        update timesheets set status = 'approved', approved_by = v_caller_id, approved_at = now(), locked_at = now(), updated_at = now() where id = p_timesheet_id;
    else
        update timesheets set status = 'draft', submitted_at = null, updated_at = now() where id = p_timesheet_id;
    end if;

    insert into timesheet_approvals (organization_id, timesheet_id, actor_user_id, action, notes)
    values (v_timesheet.organization_id, p_timesheet_id, v_caller_id, p_action, p_notes);

    perform public.create_prosm_time_notification(
        v_timesheet.organization_id, v_timesheet.user_id,
        case when p_action = 'approved' then 'timesheet_approved' else 'timesheet_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Timesheet approved' else 'Timesheet rejected' end,
        coalesce(p_notes, case when p_action = 'approved' then 'Your timesheet was approved and is now locked.' else 'Your timesheet was rejected and returned to draft.' end),
        'timesheet', p_timesheet_id
    );

    return jsonb_build_object('success', true, 'timesheetId', p_timesheet_id, 'status', p_action);
exception
    when others then
        raise exception 'APPROVE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

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

create or replace function public.cancel_prosm_time_shift_assignment(
    p_assignment_id uuid,
    p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_assignment shift_assignments%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO CANCEL SHIFT ASSIGNMENTS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_assignment from shift_assignments where id = p_assignment_id and organization_id = v_org;
    if v_assignment.id is null then raise exception 'SHIFT ASSIGNMENT NOT FOUND'; end if;
    if not public.current_prosm_time_user_is_owner() and not (v_assignment.site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;
    if v_assignment.status <> 'scheduled' then
        raise exception 'THIS SHIFT ASSIGNMENT IS ALREADY CANCELLED';
    end if;

    update shift_assignments
    set status = 'cancelled', cancelled_reason = nullif(trim(coalesce(p_reason, '')), ''), updated_at = now()
    where id = p_assignment_id;

    perform public.create_prosm_time_notification(
        v_org, v_assignment.user_id, 'shift_assigned', 'normal', 'A scheduled shift was cancelled',
        'Your shift on ' || v_assignment.shift_date::text || ' was cancelled.',
        'shift_assignments', p_assignment_id,
        jsonb_build_object('shiftDate', v_assignment.shift_date, 'cancelled', true)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CANCEL PROSM TIME SHIFT ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

commit;
