-- PROSM Time - § user-directed, 2026-09-16 (verbatim): "مفيش صفحة
-- اجازات عنده [الاونر]... يكون فيها عرض لجميع اجازات المؤسسة بخلاف
-- ونظام اصدار اجازة لنفسه هيكون مختلف بحيث انه ميستناش اي اعتماد يعني
-- بمجرد مايطلب اجازة الطلب يعتمد ولكن ده حصري عالاونر" - the Owner
-- currently has NO Leave page at all (deliberately blocked by an
-- earlier directive - "they're not requesting leave from anyone,"
-- since nobody outranks the Owner to approve it). Reversing that: the
-- Owner gets a real Leave page, but a DIFFERENT one - an org-wide view
-- of everyone's leave (not just "mine"), and a self-request that is
-- immediately auto-approved (no one to wait on), exclusive to the
-- Owner - a plain admin/manager's own request still escalates to the
-- Owner for real review, unchanged.

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
    v_caller_is_owner boolean;
    v_caller_is_reviewer boolean;
    v_has_attendance boolean;
    v_recipient record;
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
    v_caller_is_owner := public.current_prosm_time_user_is_owner();

    -- § user-directed, 2026-09-16 - the Owner's own request is
    -- exclusive: instantly self-approved, no reviewer, no wait. Same
    -- attendance-conflict guard review_prosm_time_leave already
    -- enforces for everyone else (20260913110000) - an Owner already
    -- clocked in during these dates can't auto-approve over that
    -- contradiction either; they'd need to resolve the attendance
    -- record first, same as any other approval path.
    if v_caller_is_owner then
        select exists (
            select 1 from attendance_sessions
            where user_id = v_caller_id
            and clock_in_at::date between p_start_date and p_end_date
        ) into v_has_attendance;
        if v_has_attendance then
            raise exception 'YOU HAVE ATTENDANCE RECORDED DURING THESE DATES - RESOLVE THE ATTENDANCE RECORD BEFORE REQUESTING LEAVE FOR THIS PERIOD';
        end if;

        insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, status, reviewed_by, reviewed_at)
        values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), 'approved', v_caller_id, now())
        returning id into v_request_id;

        return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', true);
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;

    v_caller_is_reviewer := 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]));

    if v_caller_is_reviewer then
        for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
            );
        end loop;
    else
        perform public.notify_prosm_time_managers_of_subject_or_owner(
            v_org, v_caller_id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
            v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
            'leave_requests', v_request_id,
            jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
        );
    end if;

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', false);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

-- Org-wide read for the Owner's new Leave page - the RLS policy
-- already permits the Owner to see every row (20260913100000's own
-- "members can view own leave requests" policy: user_id = self OR
-- current_prosm_time_user_is_owner() OR manager-of-subordinate), this
-- just adds the employee name join the existing listMine() query
-- never needed for a single person's own list.
create or replace function public.list_prosm_time_all_leave_requests()
returns table (
    id uuid,
    user_id uuid,
    employee_name text,
    leave_type text,
    start_date date,
    end_date date,
    days_count numeric,
    reason text,
    status text,
    reviewed_by_name text,
    reviewed_at timestamptz,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
begin
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE OWNER MAY VIEW THE ORGANIZATION-WIDE LEAVE LIST';
    end if;

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, lr.status, ru.full_name, lr.reviewed_at, lr.created_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    left join users ru on ru.id = lr.reviewed_by
    where lr.organization_id = public.current_prosm_time_organization_id()
    order by lr.created_at desc;
end;
$function$;

grant execute on function public.list_prosm_time_all_leave_requests() to authenticated;

commit;
