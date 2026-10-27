-- v2.3.55 (owner 2026-10-27, after the live test):
--   * "the one asking for leave chooses who receives it - the owner or one
--     of the managers - from a list of names; the request, its notification
--     and its email go to that person, and the answer comes back to the
--     requester";
--   * "the emails go back and forth on the same thread";
--   * "three cases: approved, declined, and cancelled after approval".
-- list_prosm_time_leave_reviewers gives the requester the people who may
-- approve their leave (the Owner, and Managers above them at their sites
-- holding leave.approve). request_prosm_time_leave takes the chosen one
-- (p_reviewer_id, optional: without it the old routing stays) and notifies
-- only them. Taking back an approved leave is notified as "cancelled".
-- get_prosm_time_leave_email covers the requester's copy of the request,
-- the cancellation, and the requester withdrawing an approved leave; every
-- email of one request carries the same subject, so mail apps keep them in
-- one conversation.
-- review_prosm_time_leave and request_prosm_time_leave are otherwise
-- unchanged from 20261025180000 / 20261025160000.

begin;

alter table public.leave_requests add column if not exists requested_reviewer_id uuid references public.users(id) on delete set null;
comment on column public.leave_requests.requested_reviewer_id is 'Who the requester sent this leave request to (v2.3.55).';

-- The people who may approve a person's leave: the Owner, and active
-- Managers at the person's sites who hold leave.approve and rank above them.
create or replace function public.prosm_time_leave_reviewers_for(p_user_id uuid)
returns table (id uuid, full_name text, is_owner boolean)
language sql
stable
security definer
set search_path = public
as $function$
    select u.id, u.full_name, u.is_owner
    from users u
    where u.organization_id = (select organization_id from users where id = p_user_id)
      and u.is_active and u.id <> p_user_id
      and (
          u.is_owner
          or (
              public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_user_id)
              and exists (
                  select 1 from site_assignments msa
                  join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = p_user_id
                  where msa.user_id = u.id and msa.role_at_site = 'manager'
              )
          )
      );
$function$;

revoke all on function public.prosm_time_leave_reviewers_for(uuid) from public, anon, authenticated;

create or replace function public.list_prosm_time_leave_reviewers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.full_name, 'isOwner', r.is_owner) order by r.is_owner, r.full_name)
        from public.prosm_time_leave_reviewers_for(v_caller) r
    ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_prosm_time_leave_reviewers() from public, anon;
grant execute on function public.list_prosm_time_leave_reviewers() to authenticated;

drop function if exists public.request_prosm_time_leave(text, date, date, text, text);

create or replace function public.request_prosm_time_leave(p_leave_type text, p_start_date date, p_end_date date, p_reason text default null, p_document_path text default null, p_reviewer_id uuid default null)
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
    v_notified boolean := false;
    v_has_attendance boolean;
    v_recipient record;
    v_document text := nullif(trim(coalesce(p_document_path, '')), '');
    v_reviewer uuid := p_reviewer_id;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    if p_end_date < p_start_date then
        raise exception 'END DATE MUST NOT BE BEFORE START DATE';
    end if;
    perform public.prosm_time_check_leave_rules(v_caller_id, p_leave_type, p_start_date, p_end_date, v_document);

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

    if v_caller_is_owner then
        select exists (
            select 1 from attendance_sessions
            where user_id = v_caller_id
            and clock_in_at::date between p_start_date and p_end_date
        ) into v_has_attendance;
        if v_has_attendance then
            raise exception 'YOU HAVE ATTENDANCE RECORDED DURING THESE DATES - RESOLVE THE ATTENDANCE RECORD BEFORE REQUESTING LEAVE FOR THIS PERIOD';
        end if;

        insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, status, reviewed_by, reviewed_at, document_path)
        values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), 'approved', v_caller_id, now(), v_document)
        returning id into v_request_id;

        return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', true);
    end if;

    -- v2.3.55: the requester chooses who receives it (one of the people who may approve it)
    if v_reviewer is not null and not exists (select 1 from public.prosm_time_leave_reviewers_for(v_caller_id) r where r.id = v_reviewer) then
        raise exception 'CHOOSE SOMEONE WHO CAN APPROVE YOUR LEAVE';
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, document_path, requested_reviewer_id)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), v_document, v_reviewer)
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;

    v_caller_is_reviewer := 'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]));

    if v_reviewer is not null then
        perform public.create_prosm_time_notification(
            v_org, v_reviewer, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
            v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
            'leave_requests', v_request_id,
            jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                               'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
        );
    elsif v_caller_is_reviewer then
        for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                   'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
            );
        end loop;
    else
        for v_recipient in
            select distinct u.id from users u
            join site_assignments msa on msa.user_id = u.id and msa.role_at_site = 'manager'
            join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = v_caller_id
            where u.organization_id = v_org and u.is_active and not u.is_owner and u.id <> v_caller_id
              and public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_caller_id)
        loop
            v_notified := true;
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                   'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
            );
        end loop;
        if not v_notified then
            for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
            loop
                perform public.create_prosm_time_notification(
                    v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                    v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                    'leave_requests', v_request_id,
                    jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days, 'leaveType', p_leave_type,
                                       'startDate', p_start_date, 'endDate', p_end_date, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
                );
            end loop;
        end if;
    end if;

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', false);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.request_prosm_time_leave(text, date, date, text, text, uuid) from public, anon;
grant execute on function public.request_prosm_time_leave(text, date, date, text, text, uuid) to authenticated;

create or replace function public.review_prosm_time_leave(p_request_id uuid, p_action text, p_notes text default null, p_deduction_per_day numeric default null)
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
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;
    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if not public.prosm_time_caller_has_authority_over(v_request.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    -- Step 8 (item 20): an approved leave is revoked only before it starts.
    if v_request.status = 'approved' and p_action = 'rejected' and public.prosm_time_leave_started(v_request) then
        raise exception 'THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED';
    end if;
    if v_request.status = 'approved' and p_action = 'approved' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    -- Step 9 (item 19): unpaid leave is approved with its deduction per day.
    if p_action = 'approved' and v_request.leave_type = 'unpaid' then
        if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.set_deduction') then
            raise exception 'LEAVE.SET_DEDUCTION AUTHORITY REQUIRED';
        end if;
        if p_deduction_per_day is null or p_deduction_per_day < 0 then
            raise exception 'THE DEDUCTION PER DAY IS REQUIRED FOR UNPAID LEAVE';
        end if;
    end if;

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

    if p_action = 'approved' and v_request.leave_type = 'unpaid' then
        perform public.prosm_time_record_leave_deduction(p_request_id, p_deduction_per_day, v_caller_id, nullif(trim(coalesce(p_notes, '')), ''));
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
        values (v_org, v_caller_id, v_request.user_id, 'leave.deduction_set', 'leave_requests', p_request_id, 'Unpaid leave approved with its deduction',
                (select jsonb_build_object('perDay', deduction_per_day, 'days', deduction_days, 'total', deduction_total, 'currency', deduction_currency)
                 from leave_requests where id = p_request_id));
    end if;

    if v_request.status = 'approved' and p_action = 'rejected' then
        perform public.prosm_time_after_leave_cancelled(p_request_id, v_caller_id, nullif(trim(coalesce(p_notes, '')), ''));
    end if;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.create_prosm_time_notification(
        v_org, v_request.user_id, 'correction_reviewed', 'normal', 'Your leave request was reviewed',
        'Decision: ' || p_action || '.', 'leave_requests', p_request_id,
        -- v2.3.55: taking back an approved leave reads as "cancelled", not "declined"
        jsonb_build_object('kind', 'leave', 'actionType', case when v_request.status = 'approved' and p_action = 'rejected' then 'cancelled' else p_action end) || case when nullif(trim(coalesce(p_notes, '')), '') is not null then jsonb_build_object('notes', trim(p_notes)) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REVIEW PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.review_prosm_time_leave(uuid, text, text, numeric) from public, anon;
grant execute on function public.review_prosm_time_leave(uuid, text, text, numeric) to authenticated, service_role;

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
    if v_note.id is null or v_note.related_entity_type is distinct from 'leave_requests' then return null; end if;
    if v_note.type = 'exception_pending_review' and v_note.data ->> 'kind' = 'leave' then
        v_kind := 'request';
    elsif v_note.type = 'exception_pending_review' and v_note.data ->> 'kind' = 'leave_cancelled' then
        -- the requester withdrew an approved leave: the person who approved it hears
        v_kind := 'withdrawn';
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
                           or (v_kind = 'withdrawn' and v_request.reviewed_by = v_recipient.id),
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

-- A notice is skipped as a duplicate of one sent in the last 15 minutes
-- about the same thing - but a different decision is news: approving a
-- leave and then taking it back within 15 minutes used to send only the
-- approval (found while testing the cancellation email).
create or replace function public.create_prosm_time_notification(
    p_organization_id uuid,
    p_user_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null,
    p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
    if p_priority <> 'high' and p_related_entity_id is not null and exists (
        select 1 from notifications
        where user_id = p_user_id and type = p_type and related_entity_id = p_related_entity_id
        and coalesce(data ->> 'actionType', '') = coalesce(p_data ->> 'actionType', '')
        and coalesce(data ->> 'kind', '') = coalesce(p_data ->> 'kind', '')
        and created_at > now() - interval '15 minutes'
    ) then
        return;
    end if;

    insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
    values (p_organization_id, p_user_id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, coalesce(p_data, '{}'::jsonb));
end;
$function$;

-- a withdrawn approved leave is emailed too, phone or not
create or replace function public.prosm_time_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if (
           exists (select 1 from push_devices where user_id = new.user_id)
           or (new.related_entity_type = 'leave_requests' and coalesce(new.data ->> 'kind', '') in ('leave', 'leave_cancelled'))
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

commit;
