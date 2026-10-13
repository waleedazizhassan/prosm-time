-- Audit 2026-10-12, item 4.8 - one trip outside the work area (a
-- clock-out there, then a clock-in there) created two geofence
-- exceptions and the employee had to give the same reason twice. A
-- submitted reason now also covers the employee's other exceptions still
-- waiting for a reason from the same trip (created within 12 hours);
-- each stays its own row for the managers' review and the reports.

begin;

create or replace function public.submit_prosm_time_exception_reason(
    p_exception_id uuid,
    p_reason_category text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_exception geofence_exceptions%rowtype;
    v_caller_name text;
    v_covered integer;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;
    if p_reason_category not in ('purchasing_food', 'restroom', 'work_assignment', 'emergency', 'other') then
        raise exception 'INVALID REASON CATEGORY';
    end if;

    select * into v_exception from geofence_exceptions where id = p_exception_id and user_id = v_caller_id;
    if v_exception.id is null then
        raise exception 'EXCEPTION NOT FOUND';
    end if;
    if v_exception.status <> 'pending_reason' then
        raise exception 'THIS EXCEPTION ALREADY HAS A REASON';
    end if;

    -- Audit 4.8 - one trip outside the area (clock out there, clock in
    -- again there) made two exceptions and the employee explained twice.
    -- The reason now covers every exception of theirs still waiting for a
    -- reason from the same trip (within 12 hours of this one).
    update geofence_exceptions
    set reason_category = p_reason_category, employee_reason = p_reason, reason_submitted_at = now(), status = 'pending_review'
    where user_id = v_caller_id
      and (
          id = p_exception_id
          or (status = 'pending_reason' and created_at between v_exception.created_at - interval '12 hours' and v_exception.created_at + interval '12 hours')
      );
    get diagnostics v_covered = row_count;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_exception.organization_id, 'exception_pending_review', 'normal', 'Exception awaiting your review',
        v_caller_name || ' submitted a reason for an out-of-zone exception.',
        'geofence_exceptions', p_exception_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'exception')
    );

    return jsonb_build_object('success', true, 'exceptionsCovered', v_covered);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME EXCEPTION REASON FAILED: %', sqlerrm;
end;
$function$;

commit;
