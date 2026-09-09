-- PROSM Time - real bug, user-directed: the notification a supervisor
-- gets for a pending leave request only ever said "{name} requested
-- {days} day(s) of leave" - no leave type, no actual date range, no
-- reason, so a manager could approve/reject with no real information
-- in front of them (they'd have to separately open Manager Console to
-- see anything). Adds leaveType/startDate/endDate/reason to the
-- notification's own data payload - localizeNotification.ts (frontend
-- commit alongside this migration) renders them into the actual
-- sentence.

begin;

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
    perform public.notify_prosm_time_supervisors(
        v_org, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
        v_caller_name || ' requested ' || v_days || ' day(s) of ' || p_leave_type || ' leave (' || p_start_date::text || ' to ' || p_end_date::text || ').'
            || case when nullif(trim(coalesce(p_reason, '')), '') is not null then ' Reason: ' || p_reason || '.' else '' end,
        'leave_requests', v_request_id,
        jsonb_build_object(
            'employeeName', v_caller_name, 'kind', 'leave', 'days', v_days,
            'leaveType', p_leave_type, 'startDate', p_start_date, 'endDate', p_end_date,
            'reason', nullif(trim(coalesce(p_reason, '')), '')
        )
    );

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

commit;
