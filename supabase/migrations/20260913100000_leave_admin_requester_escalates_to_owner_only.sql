-- PROSM Time - real bug report (screenshot): a leave request from an
-- employee with NO site assignment was still reaching a site manager
-- (not just the Owner), and a manager/supervisor requesting their OWN
-- leave was getting notified about their own request.
--
-- Root cause: notify_prosm_time_managers_of_subject_or_owner()
-- (20260911200000) finds "managers of the requester's own sites" -
-- correct for a plain employee, but wrong when the requester IS
-- themselves a manager of one of those sites: the query never
-- excluded the caller from their own recipient list.
--
-- User's own stated rule, implemented exactly: a leave request only
-- ever reaches a site manager when the requester is a plain employee
-- (holds no 'exceptions.manage' authority) who IS assigned to a real
-- site. Every other case - no site assignment, OR the requester
-- themselves holds review/manager authority - escalates straight to
-- the Owner only, never to a peer or to themselves.

begin;

-- Visibility follows the same rule as the notification above: a
-- manager can see another member's leave request only when that
-- member is a plain employee (holds no 'exceptions.manage' authority)
-- assigned to one of the caller's managed sites. A manager/supervisor's
-- own leave request is visible to themselves and the Owner only.
drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or (
        'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        and not (
            'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(leave_requests.user_id), array[]::text[]))
        )
        and exists (
            select 1 from site_assignments sa
            where sa.user_id = leave_requests.user_id
            and sa.site_id = any(public.current_prosm_time_managed_site_ids())
        )
    )
);

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
    v_caller_is_reviewer boolean;
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

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;

    v_caller_is_reviewer := public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]));

    if v_caller_is_reviewer then
        -- § user-directed, 2026-09-13 - an admin/manager/supervisor's
        -- own leave request escalates straight to the Owner only -
        -- never to themselves, never to a peer manager at the same
        -- site.
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

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

commit;
