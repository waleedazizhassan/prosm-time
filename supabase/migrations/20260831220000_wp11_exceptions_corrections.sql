-- WP-11 (§19 Out-of-Zone Exception Workflow, §17.3 Employee Self-
-- Correction Request). Notification delivery (§19 steps 3/6: "Notify
-- employee... Notify the responsible manager") is explicitly WP-13's
-- own row ("Notifications") - this pass records the real workflow
-- data/state WP-13 will later deliver notifications about, never the
-- delivery itself. Per §17.3, approving a correction request NEVER
-- overwrites the original attendance_events/attendance_sessions data -
-- it only changes the correction_requests row's own status; actually
-- applying an approved correction to reported hours is WP-16's job.

create table public.geofence_exceptions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    attendance_event_id uuid not null references public.attendance_events(id) on delete cascade,
    distance_meters double precision not null,
    status text not null default 'pending_reason' check (status in ('pending_reason', 'pending_review', 'resolved')),
    reason_category text check (reason_category in ('purchasing_food', 'restroom', 'work_assignment', 'emergency', 'other')),
    employee_reason text,
    reason_submitted_at timestamptz,
    created_at timestamptz not null default now()
);

create index geofence_exceptions_organization_id_idx on public.geofence_exceptions(organization_id);
create index geofence_exceptions_user_id_idx on public.geofence_exceptions(user_id);

create table public.correction_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    attendance_session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    proposed_event_type text not null check (proposed_event_type in ('clock_in', 'clock_out')),
    proposed_correct_time timestamptz not null,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'acknowledged', 'clarification_requested')),
    created_at timestamptz not null default now()
);

create index correction_requests_organization_id_idx on public.correction_requests(organization_id);
create index correction_requests_user_id_idx on public.correction_requests(user_id);

-- §19 step 8: "Write every action to audit history" - the append-only
-- log of every manager decision on either exception type (§17.3: "the
-- same manager review/approval queue"). Exactly one of the two FKs is
-- ever set - real referential integrity instead of a loose polymorphic
-- reference.
create table public.exception_actions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    geofence_exception_id uuid references public.geofence_exceptions(id) on delete cascade,
    correction_request_id uuid references public.correction_requests(id) on delete cascade,
    actor_user_id uuid not null references public.users(id) on delete restrict,
    action_type text not null check (action_type in ('approved', 'rejected', 'acknowledged', 'clarification_requested')),
    notes text,
    created_at timestamptz not null default now(),
    constraint exception_actions_exactly_one_target check (
        (geofence_exception_id is not null and correction_request_id is null)
        or (geofence_exception_id is null and correction_request_id is not null)
    )
);

create index exception_actions_geofence_exception_id_idx on public.exception_actions(geofence_exception_id);
create index exception_actions_correction_request_id_idx on public.exception_actions(correction_request_id);

alter table public.geofence_exceptions enable row level security;
alter table public.correction_requests enable row level security;
alter table public.exception_actions enable row level security;

revoke all on public.geofence_exceptions from anon, authenticated;
revoke all on public.correction_requests from anon, authenticated;
revoke all on public.exception_actions from anon, authenticated;

grant select on public.geofence_exceptions to authenticated;
grant select on public.correction_requests to authenticated;
grant select on public.exception_actions to authenticated;

-- Same visibility posture as every other attendance-adjacent table:
-- subject sees own, org-wide requires 'attendance.view' or Owner.
create policy "geofence exceptions visible to subject or attendance.view"
on public.geofence_exceptions for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (organization_id = public.current_prosm_time_organization_id() and (public.current_prosm_time_user_is_owner() or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))))
);

create policy "correction requests visible to subject or attendance.view"
on public.correction_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (organization_id = public.current_prosm_time_organization_id() and (public.current_prosm_time_user_is_owner() or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))))
);

create policy "exception actions visible to subject or attendance.view"
on public.exception_actions for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        public.current_prosm_time_user_is_owner()
        or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        or exists (select 1 from geofence_exceptions ge where ge.id = exception_actions.geofence_exception_id and ge.user_id = public.current_prosm_time_user_id())
        or exists (select 1 from correction_requests cr where cr.id = exception_actions.correction_request_id and cr.user_id = public.current_prosm_time_user_id())
    )
);

-- Re-point clock_in/clock_out (WP-06/09/10) to auto-create a
-- geofence_exceptions row when the already-computed geofence check
-- came back false (§19 steps 1-2: detection + accuracy/grace already
-- happened in compute_prosm_time_geofence_check, WP-09). Same
-- signatures, same Edge Functions.

create or replace function public.clock_in_prosm_time_attendance(
    p_site_id uuid,
    p_idempotency_key text,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
        raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
    end if;

    if p_project_id is not null then
        if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
            raise exception 'PROJECT NOT FOUND AT THIS SITE';
        end if;
        if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, v_caller_id, p_site_id, p_project_id, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason');
    end if;

    if v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false,
        'geofence', v_geofence, 'presenceSessionId', v_presence_session_id
    );
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.clock_out_prosm_time_attendance(
    p_idempotency_key text,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_event_id uuid;
    v_geofence jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is null then
        raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(v_open_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason');
    end if;

    update attendance_sessions set status = 'clocked_out', clock_out_at = now(), updated_at = now() where id = v_open_session.id;

    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'clock_out'
    where attendance_session_id = v_open_session.id and status = 'active';

    return jsonb_build_object('success', true, 'sessionId', v_open_session.id, 'eventId', v_event_id, 'replay', false, 'geofence', v_geofence);
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

-- Employee submits their reason for a pending out-of-zone exception
-- (§19 steps 3-5). Self-service, own exception only.
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

    update geofence_exceptions
    set reason_category = p_reason_category, employee_reason = p_reason, reason_submitted_at = now(), status = 'pending_review'
    where id = p_exception_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME EXCEPTION REASON FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.submit_prosm_time_exception_reason(uuid, text, text) to authenticated;

-- §17.3 - self-service, own session only. Never modifies the
-- original attendance record.
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

    return jsonb_build_object('success', true, 'correctionRequestId', v_request_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME CORRECTION REQUEST FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.submit_prosm_time_correction_request(uuid, text, timestamptz, text) to authenticated;

-- Manager review (§19 step 7, §17.3 "same manager review/approval
-- queue"). Gated on the real 'exceptions.manage' permission (already
-- seeded, WP-04) or Owner. p_kind selects which table p_target_id
-- refers to.
create or replace function public.review_prosm_time_exception(
    p_kind text,
    p_target_id uuid,
    p_action_type text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EXCEPTIONS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_kind not in ('geofence_exception', 'correction_request') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.review_prosm_time_exception(text, uuid, text, text) to authenticated;
