-- Workflow audit I5/I7, owner 2026-10-20 ("where does a decision go?").
-- I7. The reviewer's note on an exception, correction, offline time, fake
--     location or leave decision was stored but never reached the employee:
--     the notification now carries it (data.notes), and the app shows it
--     under the decision. The review functions are patched in place - only
--     the notification's data changes - and the patch refuses to run if a
--     function no longer looks as expected.
-- I5. A correction request was notified with no data (so it could not be
--     shown in the reader's language) and, for a shift clocked in away from
--     every site, only to the Owner; it now names the employee and goes to
--     the managers of the site responsible for the shift.

begin;

do $$
declare
    v_def text;
    v_notes constant text := ' || case when nullif(trim(coalesce(p_notes, '''')), '''') is not null then jsonb_build_object(''notes'', trim(p_notes)) else ''{}''::jsonb end';
    v_kind text;
begin
    v_def := pg_get_functiondef('public.review_prosm_time_exception(text, uuid, text, text)'::regprocedure);
    foreach v_kind in array array['mock_location', 'offline_time', 'exception', 'correction'] loop
        if position(format('jsonb_build_object(''kind'', %L, ''actionType'', p_action_type)', v_kind) in v_def) = 0 then
            raise exception 'review_prosm_time_exception changed - % notification not found', v_kind;
        end if;
        v_def := replace(v_def,
            format('jsonb_build_object(''kind'', %L, ''actionType'', p_action_type)', v_kind),
            format('jsonb_build_object(''kind'', %L, ''actionType'', p_action_type)', v_kind) || v_notes);
    end loop;
    execute v_def;

    v_def := pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text)'::regprocedure);
    if position('jsonb_build_object(''kind'', ''leave'', ''actionType'', p_action)' in v_def) = 0 then
        raise exception 'review_prosm_time_leave changed - leave notification not found';
    end if;
    v_def := replace(v_def,
        'jsonb_build_object(''kind'', ''leave'', ''actionType'', p_action)',
        'jsonb_build_object(''kind'', ''leave'', ''actionType'', p_action)' || v_notes);
    execute v_def;
end;
$$;

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
    v_name text;
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

    select full_name into v_name from users where id = v_caller_id;

    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, coalesce(v_session.site_id, v_session.responsible_site_id), 'exception_pending_review', 'normal', 'Correction request awaiting your review',
        v_name || ' submitted a correction request.',
        'correction_requests', v_request_id,
        jsonb_build_object('employeeName', v_name, 'kind', 'correction')
    );

    return jsonb_build_object('success', true, 'correctionRequestId', v_request_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME CORRECTION REQUEST FAILED: %', sqlerrm;
end;
$function$;

commit;
