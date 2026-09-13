-- PROSM Time - real bug report (screenshot + exact scenario): an
-- employee submitted a leave request for a day she was already
-- clocked in on; the Owner approved it ~5 hours later while she was
-- STILL clocked in - she ended up simultaneously "on leave today" and
-- actively present, a contradictory state nothing in the UI can make
-- sense of.
--
-- 20260910110000 already blocks the OPPOSITE direction (a fresh
-- clock-in once leave is already approved for today). This is the
-- missing other half: block APPROVING leave for a date range where
-- the employee already has a real attendance_sessions row (clocked in
-- or a completed session, doesn't matter which - either way "on
-- leave" and "was actually here" can't both be true for that day).
-- Rejection is never blocked - rejecting a request has no conflicting
-- state to create.

begin;

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
    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    if v_request.status = 'approved' and p_action = 'approved' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    -- § real bug fix, 2026-09-13 - see this migration's own header
    -- comment. Only checked on approval - rejecting never creates a
    -- conflicting state.
    if p_action = 'approved' and exists (
        select 1 from attendance_sessions
        where user_id = v_request.user_id
        and clock_in_at::date between v_request.start_date and v_request.end_date
    ) then
        raise exception 'THIS EMPLOYEE HAS ATTENDANCE RECORDED DURING THIS LEAVE PERIOD - RESOLVE THE ATTENDANCE RECORD BEFORE APPROVING';
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

commit;
