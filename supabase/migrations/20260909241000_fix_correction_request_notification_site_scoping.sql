-- PROSM Time - real bug found during a full notification-routing audit
-- (user-directed): submit_prosm_time_correction_request notified via
-- the org-wide notify_prosm_time_supervisors() - every 'exceptions.
-- manage' holder org-wide, even ones who don't manage the relevant
-- site. correction_requests' own RLS (20260902090000/20260909110000)
-- already site-scopes WHO CAN SEE a given request via
-- current_prosm_time_managed_site_ids() - so an unrelated site's
-- manager was getting a notification for something they'd find hidden
-- the moment they tried to open it. Exactly the same class of bug
-- 20260904130000 already fixed for geofence violations (that
-- migration's own header comment explicitly named "correction/
-- allowance reviews... genuinely org-wide" as staying untouched - this
-- one case turns out not to fit that framing, since - unlike a
-- straightforward allowance review - a correction request is always
-- tied to one specific attendance_sessions.site_id, exactly like a
-- geofence violation is). Reuses notify_prosm_time_site_managers_or_
-- owner() (already built, already handles the site-id-null fallback
-- to Owner-only) rather than duplicating its logic.

begin;

create or replace function public.submit_prosm_time_correction_request(
    p_attendance_session_id uuid,
    p_proposed_event_type text,
    p_proposed_correct_time timestamptz,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session attendance_sessions%rowtype;
    v_request_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_proposed_event_type not in ('clock_in', 'clock_out') then
        raise exception 'INVALID PROPOSED EVENT TYPE';
    end if;
    if p_proposed_correct_time is null then
        raise exception 'PROPOSED CORRECT TIME IS REQUIRED';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;

    insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason)
    values (v_caller_org, v_caller_id, p_attendance_session_id, p_proposed_event_type, p_proposed_correct_time, trim(p_reason))
    returning id into v_request_id;

    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, v_session.site_id, 'exception_pending_review', 'normal', 'Correction request awaiting your review',
        (select full_name from users where id = v_caller_id) || ' submitted a correction request.',
        'correction_requests', v_request_id
    );

    return jsonb_build_object('success', true, 'correctionRequestId', v_request_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME CORRECTION REQUEST FAILED: %', sqlerrm;
end;
$function$;

commit;
