-- PROSM Time - 2 more real bugs from live user testing, same "a
-- Manager's authority is scoped to the sites they actually manage"
-- class as 20260910200000/20260911180000:
--
--   1. request_prosm_time_leave notified via the org-wide
--      notify_prosm_time_supervisors() - every 'exceptions.manage'
--      holder org-wide, including a manager who doesn't manage any of
--      the requester's sites, and (the reported case) a manager even
--      when the requester has NO site assignment at all - a case that
--      should reach the Owner only, mirroring 20260911180000's own
--      "unassigned employee is Owner-only visibility" rule. leave_
--      requests' own SELECT policy (20260910200000) already scopes
--      correctly by the requester's site_assignments - this fixes the
--      notification to match what the recipient can actually see.
--      New notify_prosm_time_managers_of_subject_or_owner() (a subject
--      user_id, not a single site_id like notify_prosm_time_site_
--      managers_or_owner() - a leave requester can have zero, one, or
--      several site_assignments rows, unlike a correction/geofence
--      event which is always tied to exactly one attendance session's
--      site_id) is the reusable version of this for user-scoped (as
--      opposed to session/site-scoped) notifications.
--
--   2. break_events' own SELECT policy (20260901100000) grants any
--      'attendance.view' holder org-wide visibility, completely
--      unscoped - so a manager who does NOT manage an on-break
--      employee's site (or the employee has none) still saw them in
--      "on break now" (AttendanceRepository.listOnBreakNow(), the
--      Dashboard KPI), even though that same employee is correctly
--      invisible everywhere else after 20260911180000's users-table
--      fix. Rescoped through the parent attendance_sessions row (every
--      break_event has exactly one, via attendance_session_id) using
--      that table's own already-correct site-scoped policy condition
--      (20260902090000) - a null site_id (manual/no-site session)
--      already correctly resolves to Owner-only there, so this
--      inherits that for free, no separate "unassigned" branch needed.
--      (allowance_entries and project_assignments were flagged with
--      this same old unscoped pattern by 20260911180000's own header
--      comment - left untouched here, not part of this report.)

begin;

create or replace function public.notify_prosm_time_managers_of_subject_or_owner(
    p_organization_id uuid,
    p_subject_user_id uuid,
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
    v_recipient record;
begin
    for v_recipient in
        select distinct u.id
        from users u
        join site_assignments sa on sa.user_id = u.id
        where u.organization_id = p_organization_id
        and sa.role_at_site = 'manager'
        and sa.site_id in (select site_id from site_assignments where user_id = p_subject_user_id)
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;

    -- The Owner always sees this too - both as the no-site fallback
    -- and as the standing escalation on top of that employee's own
    -- site manager(s). create_prosm_time_notification's own 15-minute
    -- dedup already makes a double-call harmless if the Owner also
    -- happens to be one of the site's own assigned managers.
    for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke all on function public.notify_prosm_time_managers_of_subject_or_owner(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.request_prosm_time_leave(
    p_leave_type text,
    p_start_date date,
    p_end_date date,
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
    v_caller_name text;
    v_days numeric;
    v_request_id uuid;
    v_has_overlap boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_leave_type not in ('annual', 'sick', 'unpaid', 'emergency', 'other') then
        raise exception 'INVALID LEAVE TYPE';
    end if;
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    if p_end_date < p_start_date then
        raise exception 'END DATE MUST NOT BE BEFORE START DATE';
    end if;

    select exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status in ('pending', 'approved')
          and p_start_date <= end_date and p_end_date >= start_date
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'YOU ALREADY HAVE A PENDING OR APPROVED LEAVE REQUEST OVERLAPPING THESE DATES';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_days := (p_end_date - p_start_date) + 1;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_managers_of_subject_or_owner(
        v_org, v_caller_id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
        v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
        'leave_requests', v_request_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
    );

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

drop policy if exists "break events visible to subject or attendance.view" on public.break_events;
create policy "break events visible to subject or attendance.view"
on public.break_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and exists (
                    select 1 from attendance_sessions s
                    where s.id = break_events.attendance_session_id
                    and s.site_id = any(public.current_prosm_time_managed_site_ids())
                )
            )
        )
    )
);

commit;
