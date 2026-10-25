-- PROSM Time v2.3.43, step 8 (item 20): an approved leave can be cancelled
-- only BEFORE its first day. From the start date on (today in the
-- organisation's time zone, Africa/Cairo by default) it can no longer be
-- cancelled - not all of it, not part of it - by anyone, the Owner included.
--   * cancel_prosm_time_leave_request: the employee may now also cancel
--     their own APPROVED leave, but only before it starts (a pending one as
--     before); the approvers are told;
--   * review_prosm_time_leave: revoking an approved leave (action
--     'rejected' on an approved request) follows the same rule;
--   * list_prosm_time_approved_leave_requests returns can_cancel so the app
--     shows the button only for leave that has not started;
--   * cancelling before the start gives the balance back (balances count
--     approved requests only), reverses any deduction (step 9) and tells the
--     employee. Audited.

begin;

create or replace function public.prosm_time_leave_started(p_request leave_requests)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select (now() at time zone public.prosm_time_site_timezone(null, p_request.organization_id))::date >= p_request.start_date;
$function$;

revoke all on function public.prosm_time_leave_started(leave_requests) from public, anon, authenticated;

-- Called by every path that ends an approved leave before it starts; step 9
-- adds the reversal of the unpaid-leave deduction here.
create or replace function public.prosm_time_after_leave_cancelled(p_request_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_request leave_requests%rowtype;
begin
    select * into v_request from leave_requests where id = p_request_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_request.organization_id, p_actor, v_request.user_id, 'leave.approved_cancelled', 'leave_requests', p_request_id,
            'Approved leave cancelled before it started', p_reason,
            jsonb_build_object('status', 'approved', 'startDate', v_request.start_date, 'endDate', v_request.end_date, 'days', v_request.days_count),
            jsonb_build_object('status', v_request.status));
end;
$function$;

revoke all on function public.prosm_time_after_leave_cancelled(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.cancel_prosm_time_leave_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_request leave_requests%rowtype;
    v_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_request from leave_requests where id = p_request_id and user_id = v_caller_id for update;
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    if v_request.status = 'approved' and public.prosm_time_leave_started(v_request) then
        raise exception 'THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED';
    end if;

    update leave_requests set status = 'cancelled', updated_at = now() where id = p_request_id;

    if v_request.status = 'approved' then
        perform public.prosm_time_after_leave_cancelled(p_request_id, v_caller_id, 'cancelled by the employee');
        select full_name into v_name from users where id = v_caller_id;
        perform public.notify_prosm_time_approvers_of(
            v_caller_id, 'leave.approve', 'exception_pending_review', 'normal', 'Approved leave cancelled',
            v_name || ' cancelled their approved leave (' || v_request.start_date || ' - ' || v_request.end_date || ').',
            'leave_requests', p_request_id,
            jsonb_build_object('employeeName', v_name, 'kind', 'leave_cancelled', 'startDate', v_request.start_date, 'endDate', v_request.end_date)
        );
    end if;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CANCEL PROSM TIME LEAVE REQUEST FAILED: %', sqlerrm;
end;
$function$;

-- Revoking an approved leave follows the same rule (effective definition
-- patched in place: everything else unchanged).
do $$
declare
    v_def text;
    v_anchor constant text := 'if v_request.status = ''approved'' and p_action = ''approved'' then';
begin
    v_def := pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then raise exception 'review_prosm_time_leave changed - approved check not found'; end if;
    v_def := replace(v_def, v_anchor,
        'if v_request.status = ''approved'' and p_action = ''rejected'' and public.prosm_time_leave_started(v_request) then' || chr(10) ||
        '        raise exception ''THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED'';' || chr(10) ||
        '    end if;' || chr(10) ||
        '    ' || v_anchor);
    v_def := replace(v_def,
        'select full_name into v_caller_name from users where id = v_caller_id;',
        'if v_request.status = ''approved'' and p_action = ''rejected'' then' || chr(10) ||
        '        perform public.prosm_time_after_leave_cancelled(p_request_id, v_caller_id, nullif(trim(coalesce(p_notes, '''')), ''''));' || chr(10) ||
        '    end if;' || chr(10) ||
        '    select full_name into v_caller_name from users where id = v_caller_id;');
    execute v_def;
end;
$$;

drop function if exists public.list_prosm_time_approved_leave_requests(boolean);
create function public.list_prosm_time_approved_leave_requests(p_upcoming_only boolean default true)
returns table(id uuid, user_id uuid, employee_name text, leave_type text, start_date date, end_date date, days_count numeric, reason text,
              reviewed_by_name text, reviewed_at timestamptz, can_cancel boolean)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_today date;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW APPROVED LEAVE REQUESTS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_today := (now() at time zone public.prosm_time_site_timezone(null, v_org))::date;

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, ru.full_name, lr.reviewed_at,
           v_today < lr.start_date
    from leave_requests lr
    join users u on u.id = lr.user_id
    left join users ru on ru.id = lr.reviewed_by
    where lr.organization_id = v_org and lr.status = 'approved'
      and public.prosm_time_caller_sees_person(lr.user_id)
      and (not p_upcoming_only or lr.end_date >= v_today)
    order by lr.start_date asc;
end;
$function$;

revoke all on function public.list_prosm_time_approved_leave_requests(boolean) from public, anon;
grant execute on function public.list_prosm_time_approved_leave_requests(boolean) to authenticated;

commit;
