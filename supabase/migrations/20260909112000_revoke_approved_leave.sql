-- PROSM Time - real fix for a gap found during today's multi-role QA
-- pass: cancel_prosm_time_leave_request's own error message
-- ("ASK YOUR MANAGER TO REVOKE AN APPROVED ONE") pointed at a real
-- capability (review_prosm_time_leave already accepts 'reject' on an
-- 'approved' request - see its own header comment, 20260908200000)
-- that had NO way to actually be reached: list_prosm_time_pending_
-- leave_requests only ever returns status = 'pending' rows, so no
-- manager-facing screen could ever find an approved request to revoke
-- it. This adds the missing listing surface + wires it into the
-- Manager Console; review_prosm_time_leave itself needs no change,
-- it already does the real work once reachable.
--
-- Same 'exceptions.manage' gate as every other leave-review RPC - "the
-- right people" here are exactly whoever can already review leave
-- requests in the first place (manager/supervisor roles by default,
-- Owner always), not a new, separate permission.

begin;

create or replace function public.list_prosm_time_approved_leave_requests(p_upcoming_only boolean default true)
returns table (
    id uuid,
    user_id uuid,
    employee_name text,
    leave_type text,
    start_date date,
    end_date date,
    days_count numeric,
    reason text,
    reviewed_by_name text,
    reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW APPROVED LEAVE REQUESTS';
    end if;

    v_org := public.current_prosm_time_organization_id();

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, ru.full_name, lr.reviewed_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    left join users ru on ru.id = lr.reviewed_by
    where lr.organization_id = v_org and lr.status = 'approved'
      and (not p_upcoming_only or lr.end_date >= current_date)
    order by lr.start_date asc;
end;
$function$;

revoke execute on function public.list_prosm_time_approved_leave_requests(boolean) from public, anon;

commit;
