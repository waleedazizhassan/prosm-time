-- v2.3.54 (owner 2026-10-26: "a leave request should arrive as a
-- notification and an email with all of its details, and when it is
-- approved the employee gets a congratulations email on the same thread:
-- approved from - to, and what is left of the balance"; "the emails are
-- between the requester's email and whoever answered, the manager or the
-- owner"):
-- send-push already receives every new notification. For the two leave
-- notifications it now also sends an email:
--   * a request awaiting review -> to the reviewer, with every detail and
--     the requester's email to answer;
--   * a decision -> to the requester (approved: congratulations, the dates
--     and the remaining balance of that type; rejected: the note), with a
--     copy to the person who decided.
-- This read gives send-push what to write, for the service role only.

begin;

create or replace function public.get_prosm_time_leave_email(p_notification_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
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
begin
    select * into v_note from notifications where id = p_notification_id;
    if v_note.id is null or v_note.related_entity_type is distinct from 'leave_requests' or coalesce(v_note.data ->> 'kind', '') <> 'leave' then
        return null;
    end if;
    if v_note.type = 'exception_pending_review' then
        v_kind := 'request';
    elsif v_note.type = 'correction_reviewed' and v_note.data ->> 'actionType' in ('approved', 'rejected') then
        v_kind := v_note.data ->> 'actionType';
    else
        return null;
    end if;

    select * into v_request from leave_requests where id = v_note.related_entity_id;
    if v_request.id is null then return null; end if;
    select * into v_recipient from users where id = v_note.user_id;
    select * into v_requester from users where id = v_request.user_id;
    select * into v_reviewer from users where id = v_request.reviewed_by;
    select * into v_type from leave_types where organization_id = v_request.organization_id and key = v_request.leave_type;

    -- what is left of this type for the year the leave starts in (the same sum as the balance page)
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
        'organizationName', (select name from organizations where id = v_request.organization_id),
        'organizationId', v_request.organization_id,
        'language', coalesce((select d.language from push_devices d where d.user_id = v_recipient.id order by d.last_seen_at desc limit 1), 'ar'),
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

revoke all on function public.get_prosm_time_leave_email(uuid) from public, anon, authenticated;
grant execute on function public.get_prosm_time_leave_email(uuid) to service_role;

commit;
