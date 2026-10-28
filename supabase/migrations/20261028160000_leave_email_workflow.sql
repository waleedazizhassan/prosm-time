-- v2.3.59 (owner 2026-10-28: "the leave request emails need a real review of
-- the workflow"). Three gaps in the emails of a leave request:
--   1. a request withdrawn before anyone answered told no one - the email
--      "awaiting your review" stayed in the reviewer's inbox for nothing; the
--      person it was sent to (or everyone who could approve it) is told now,
--      by notification and email, with a copy to the requester;
--   2. when someone other than the person it was sent to decided it, that
--      person never heard - they get a copy of the decision now;
--   3. every email of a notification was in one language - each reader's own
--      language is sent now (the emails themselves: _shared/leaveEmail.ts).
-- All three bodies are the live ones with only these changes.

begin;

CREATE OR REPLACE FUNCTION public.cancel_prosm_time_leave_request(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    else
        -- v2.3.59: withdrawn before anyone answered - the person it was sent to
        -- (or, without a chosen one, everyone who could approve it) is told, so
        -- the request in their inbox does not wait for an answer for nothing
        select full_name into v_name from users where id = v_caller_id;
        if v_request.requested_reviewer_id is not null then
            perform public.create_prosm_time_notification(
                v_request.organization_id, v_request.requested_reviewer_id, 'exception_pending_review', 'normal', 'Leave request withdrawn',
                v_name || ' withdrew their leave request (' || v_request.start_date || ' - ' || v_request.end_date || ').',
                'leave_requests', p_request_id,
                jsonb_build_object('employeeName', v_name, 'kind', 'leave_request_withdrawn', 'startDate', v_request.start_date, 'endDate', v_request.end_date)
            );
        else
            perform public.notify_prosm_time_approvers_of(
                v_caller_id, 'leave.approve', 'exception_pending_review', 'normal', 'Leave request withdrawn',
                v_name || ' withdrew their leave request (' || v_request.start_date || ' - ' || v_request.end_date || ').',
                'leave_requests', p_request_id,
                jsonb_build_object('employeeName', v_name, 'kind', 'leave_request_withdrawn', 'startDate', v_request.start_date, 'endDate', v_request.end_date)
            );
        end if;
    end if;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CANCEL PROSM TIME LEAVE REQUEST FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.prosm_time_push_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if (
           exists (select 1 from push_devices where user_id = new.user_id)
           or (new.related_entity_type = 'leave_requests' and coalesce(new.data ->> 'kind', '') in ('leave', 'leave_cancelled', 'leave_request_withdrawn'))
       )
       and exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key') then
        perform net.http_post(
            url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/send-push',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
            ),
            body := jsonb_build_object('notificationId', new.id)
        );
    end if;
    return new;
exception
    when others then
        -- A push is a best-effort extra; the notification itself always stays.
        return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_prosm_time_leave_email(p_notification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_note notifications%rowtype;
    v_request leave_requests%rowtype;
    v_type leave_types%rowtype;
    v_kind text;
    v_recipient users%rowtype;
    v_requester users%rowtype;
    v_reviewer users%rowtype;
    v_year integer;
    v_ent jsonb;
    v_used numeric;
    v_pending numeric;
    v_remaining numeric;
    v_chosen users%rowtype;
begin
    select * into v_note from notifications where id = p_notification_id;
    if v_note.id is null or v_note.related_entity_type is distinct from 'leave_requests' then return null; end if;
    if v_note.type = 'exception_pending_review' and v_note.data ->> 'kind' = 'leave' then
        v_kind := 'request';
    elsif v_note.type = 'exception_pending_review' and v_note.data ->> 'kind' = 'leave_cancelled' then
        -- the requester withdrew an approved leave: the person who approved it hears
        v_kind := 'withdrawn';
    elsif v_note.type = 'exception_pending_review' and v_note.data ->> 'kind' = 'leave_request_withdrawn' then
        -- v2.3.59: the requester withdrew a request no one had answered yet
        v_kind := 'request_withdrawn';
    elsif v_note.type = 'correction_reviewed' and v_note.data ->> 'kind' = 'leave' and v_note.data ->> 'actionType' in ('approved', 'rejected', 'cancelled') then
        v_kind := v_note.data ->> 'actionType';
    else
        return null;
    end if;

    select * into v_request from leave_requests where id = v_note.related_entity_id;
    if v_request.id is null then return null; end if;
    select * into v_recipient from users where id = v_note.user_id;
    select * into v_requester from users where id = v_request.user_id;
    select * into v_reviewer from users where id = coalesce(v_request.reviewed_by, v_request.requested_reviewer_id);
    -- the person the request was sent to, when someone else decided it
    if v_request.requested_reviewer_id is not null and v_request.reviewed_by is not null and v_request.requested_reviewer_id <> v_request.reviewed_by then
        select * into v_chosen from users where id = v_request.requested_reviewer_id;
    end if;
    select * into v_type from leave_types where organization_id = v_request.organization_id and key = v_request.leave_type;

    if v_type.id is not null then
        v_year := extract(year from v_request.start_date)::integer;
        v_ent := public.prosm_time_leave_entitlement(v_request.user_id, v_type, v_year);
        select coalesce(sum(days_count), 0) into v_used from leave_requests
        where user_id = v_request.user_id and leave_type = v_type.key and status = 'approved' and extract(year from start_date) = v_year;
        select coalesce(sum(days_count), 0) into v_pending from leave_requests
        where user_id = v_request.user_id and leave_type = v_type.key and status = 'pending' and extract(year from start_date) = v_year;
        if (v_ent -> 'entitled') is not null and jsonb_typeof(v_ent -> 'entitled') <> 'null' then
            v_remaining := (v_ent ->> 'entitled')::numeric - v_used - v_pending;
        end if;
    end if;

    return jsonb_build_object(
        'kind', v_kind,
        'requestId', v_request.id,
        'organizationName', (select name from organizations where id = v_request.organization_id),
        'organizationId', v_request.organization_id,
        'language', coalesce((select d.language from push_devices d where d.user_id = v_recipient.id order by d.last_seen_at desc limit 1), 'ar'),
        -- the request's own copy goes to the requester only when they chose one person (one copy, not one per manager)
        'copyToRequester', (v_kind = 'request' and v_request.requested_reviewer_id = v_recipient.id)
                           or (v_kind = 'withdrawn' and v_request.reviewed_by = v_recipient.id)
                           or (v_kind = 'request_withdrawn' and v_request.requested_reviewer_id = v_recipient.id),
        -- v2.3.59: each email in its reader's own language (their phone's, else Arabic)
        'languages', (
            select coalesce(jsonb_object_agg(p.id, coalesce((select d.language from push_devices d where d.user_id = p.id order by d.last_seen_at desc limit 1), 'ar')), '{}'::jsonb)
            from (select unnest(array[v_recipient.id, v_requester.id, v_request.reviewed_by, v_request.requested_reviewer_id]) as id) p
            where p.id is not null
        ),
        'chosenReviewer', case when v_chosen.id is null then null else jsonb_build_object('id', v_chosen.id, 'name', v_chosen.full_name, 'email', v_chosen.email) end,
        'recipient', jsonb_build_object('id', v_recipient.id, 'name', v_recipient.full_name, 'email', v_recipient.email),
        'requester', jsonb_build_object('id', v_requester.id, 'name', v_requester.full_name, 'email', v_requester.email),
        'reviewer', case when v_reviewer.id is null then null else jsonb_build_object('id', v_reviewer.id, 'name', v_reviewer.full_name, 'email', v_reviewer.email) end,
        'leave', jsonb_build_object(
            'type', v_request.leave_type,
            'typeName', v_type.name,
            'isPaid', v_type.is_paid,
            'startDate', v_request.start_date,
            'endDate', v_request.end_date,
            'days', v_request.days_count,
            'reason', v_request.reason,
            'notes', v_note.data ->> 'notes',
            'requestedAt', v_request.created_at
        ),
        'remainingDays', v_remaining
    );
end;
$function$;

commit;
