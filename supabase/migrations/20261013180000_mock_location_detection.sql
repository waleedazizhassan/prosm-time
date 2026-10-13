-- Audit 2026-10-12, item 2.4 - no fake-GPS detection. The Android app
-- now sends whether the location it read is simulated (a mock location
-- app; the location plugin's own isFromMockProvider flag) with clock in
-- and clock out, as p_is_mock_location (null when unknown: browsers,
-- iOS, desktop).
-- * Recorded on the event (attendance_events.is_mock_location).
-- * When true: a review item for the managers (mock_location_flags, same
--   reach as geofence exceptions; Manager console "pending review"), and
--   a row in the Location Violations report (type 'mock_location').
-- * New organisation setting reject_mock_location (default off, Owner
--   only): when on, a clock in/out with a simulated location is refused.

begin;

alter table public.organization_settings add column if not exists reject_mock_location boolean not null default false;
alter table public.attendance_events add column if not exists is_mock_location boolean;

create table if not exists public.mock_location_flags (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    attendance_event_id uuid not null unique references public.attendance_events(id) on delete cascade,
    event_type text not null check (event_type in ('clock_in', 'clock_out')),
    latitude double precision,
    longitude double precision,
    occurred_at timestamptz not null,
    status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected', 'acknowledged')),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now()
);

create index if not exists mock_location_flags_organization_id_idx on public.mock_location_flags(organization_id);
create index if not exists mock_location_flags_user_id_idx on public.mock_location_flags(user_id);

alter table public.mock_location_flags enable row level security;

drop policy if exists "mock location flags visible to subject or attendance.view" on public.mock_location_flags;
create policy "mock location flags visible to subject or attendance.view"
on public.mock_location_flags for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and (site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
        )
    )
);

revoke all on public.mock_location_flags from anon;
grant select on public.mock_location_flags to authenticated;

create or replace function public.record_prosm_time_mock_location(
    p_organization_id uuid,
    p_user_id uuid,
    p_site_id uuid,
    p_attendance_event_id uuid,
    p_event_type text,
    p_latitude double precision,
    p_longitude double precision,
    p_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_id uuid;
begin
    insert into mock_location_flags (organization_id, user_id, site_id, attendance_event_id, event_type, latitude, longitude, occurred_at)
    values (p_organization_id, p_user_id, p_site_id, p_attendance_event_id, p_event_type, p_latitude, p_longitude, p_occurred_at)
    on conflict (attendance_event_id) do nothing
    returning id into v_id;
    return v_id;
end;
$function$;

revoke execute on function public.record_prosm_time_mock_location(uuid, uuid, uuid, uuid, text, double precision, double precision, timestamptz) from public, anon, authenticated;

-- Owner only, like the other organisation-wide attendance settings.
create or replace function public.set_prosm_time_reject_mock_location(p_reject boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org_id uuid;
begin
    if public.current_prosm_time_user_id() is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CHANGE THIS SETTING';
    end if;
    v_org_id := public.current_prosm_time_organization_id();
    update organization_settings set reject_mock_location = coalesce(p_reject, false), updated_at = now() where organization_id = v_org_id;
    return jsonb_build_object('success', true);
end;
$function$;

revoke execute on function public.set_prosm_time_reject_mock_location(boolean) from public, anon;
grant execute on function public.set_prosm_time_reject_mock_location(boolean) to authenticated, service_role;

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean);
drop function if exists public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text, boolean);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null,
    p_note text default null,
    p_activity text default null,
    p_offline_replay boolean default false,
    p_is_mock_location boolean default null
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
    v_manual_label text;
    v_is_exempt boolean;
    v_walkin_check jsonb;
    v_no_site_radius integer;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
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

    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, null, p_site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status = 'approved'
          and current_date between start_date and end_date
    ) then
        raise exception 'YOU ARE ON APPROVED LEAVE TODAY';
    end if;

    update presence_sessions
    set status = 'ended', ended_at = now(), end_reason = 'orphan_auto_closed'
    where user_id = v_caller_id
      and status = 'active'
      and (
        attendance_session_id is null
        or not exists (
            select 1 from attendance_sessions
            where attendance_sessions.id = presence_sessions.attendance_session_id
              and attendance_sessions.status = 'clocked_in'
        )
      );

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = p_site_id and user_id = v_caller_id;

        if v_is_exempt is null then
            if v_site.geofence_required then
                v_walkin_check := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);
                if not (coalesce((v_walkin_check->>'checked')::boolean, false) and coalesce((v_walkin_check->>'withinGeofence')::boolean, false)) then
                    raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
                end if;
            else
                raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
            end if;
            v_is_exempt := false;
        end if;

        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then
                raise exception 'CLOCK_IN_BLOCKED_CONTACT_MANAGER';
            end if;
        end if;

        if p_project_id is not null then
            if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
                raise exception 'PROJECT NOT FOUND AT THIS SITE';
            end if;
            if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
                raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
            end if;
        end if;
    else
        v_manual_label := nullif(trim(p_manual_location_label), '');
        if v_manual_label is null then
            raise exception 'WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED';
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    -- Audit 2.4 - a location the device reports as simulated (Android mock
    -- location): refused when the organisation says so, otherwise kept
    -- and sent to the managers for review.
    if p_is_mock_location and exists (select 1 from organization_settings where organization_id = v_caller_org and reject_mock_location) then
        raise exception 'A FAKE LOCATION IS NOT ACCEPTED';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', v_effective_time, v_manual_label)
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity, time_source, is_mock_location
    ) values (
        v_session_id, v_caller_id, 'clock_in', v_effective_time, p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), ''), v_time_source, p_is_mock_location
    )
    returning id into v_event_id;

    if p_is_mock_location then
        perform public.record_prosm_time_mock_location(v_caller_org, v_caller_id, p_site_id, v_event_id, 'clock_in', p_latitude, p_longitude, v_effective_time);
    end if;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, p_site_id, 'clock_in', 'attendance_events', v_event_id, v_effective_time);
    end if;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => p_site_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', v_effective_time)
        returning id into v_presence_session_id;
    elsif p_site_id is null and p_latitude is not null and p_longitude is not null then
        select no_site_allowed_radius_meters into v_no_site_radius from organization_settings where organization_id = v_caller_org;
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, anchor_latitude, anchor_longitude, radius_meters, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, null, p_latitude, p_longitude, coalesce(v_no_site_radius, 500), 'active', v_effective_time)
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

create function public.clock_out_prosm_time_attendance(
    p_idempotency_key text,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_note text default null,
    p_activity text default null,
    p_offline_replay boolean default false,
    p_is_mock_location boolean default null
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
    v_site sites%rowtype;
    v_is_exempt boolean;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
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

    -- Audit 2.4 - a location the device reports as simulated (Android mock
    -- location): refused when the organisation says so, otherwise kept
    -- and sent to the managers for review.
    if p_is_mock_location and exists (select 1 from organization_settings where organization_id = v_caller_org and reject_mock_location) then
        raise exception 'A FAKE LOCATION IS NOT ACCEPTED';
    end if;

    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_open_session.clock_in_at, v_open_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    v_geofence := public.compute_prosm_time_geofence_check(v_open_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    if v_open_session.site_id is not null and (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        select * into v_site from sites where id = v_open_session.site_id;
        select is_exempt_from_restrictions into v_is_exempt from site_assignments where site_id = v_open_session.site_id and user_id = v_caller_id;

        if v_site.block_self_clock_out_outside_geofence and not coalesce(v_is_exempt, false) then
            raise exception 'CLOCK_OUT_BLOCKED_CONTACT_MANAGER';
        end if;
    end if;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters, note, activity, time_source, is_mock_location
    ) values (
        v_open_session.id, v_caller_id, 'clock_out', v_effective_time, p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision,
        nullif(trim(p_note), ''), nullif(trim(p_activity), ''), v_time_source, p_is_mock_location
    )
    returning id into v_event_id;

    if p_is_mock_location then
        perform public.record_prosm_time_mock_location(v_caller_org, v_caller_id, v_open_session.site_id, v_event_id, 'clock_out', p_latitude, p_longitude, v_effective_time);
    end if;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_caller_org, v_caller_id, v_open_session.site_id, 'clock_out', 'attendance_events', v_event_id, v_effective_time);
    end if;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        perform public.handle_prosm_time_geofence_violation(
            v_caller_org, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
            p_attendance_event_id => v_event_id, p_site_id => v_open_session.site_id
        );
    end if;

    update attendance_sessions set status = 'clocked_out', clock_out_at = v_effective_time, updated_at = now() where id = v_open_session.id;

    update presence_sessions
    set status = 'ended', ended_at = v_effective_time, end_reason = 'clock_out'
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
    v_session attendance_sessions%rowtype;
    v_ot offline_time_reviews%rowtype;
    v_mock mock_location_flags%rowtype;
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

    if p_kind not in ('geofence_exception', 'correction_request', 'offline_time', 'mock_location') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    -- Audit 1.4 - an offline action recorded with the device's time: the
    -- decision is kept on the review itself (the recorded time stays; a
    -- correction request or an admin edit changes it when needed).
    -- Audit 2.4 - a clock in/out from a location the device reported as simulated.
    if p_kind = 'mock_location' then
        select * into v_mock from mock_location_flags where id = p_target_id and organization_id = v_caller_org;
        if v_mock.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;

        update mock_location_flags
        set status = case p_action_type when 'clarification_requested' then 'pending_review' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_mock.user_id, 'correction_reviewed', 'normal', 'Your location was reviewed',
            'Decision: ' || p_action_type || '.', 'mock_location_flags', p_target_id,
            jsonb_build_object('kind', 'mock_location', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'offline_time' then
        select * into v_ot from offline_time_reviews where id = p_target_id and organization_id = v_caller_org;
        if v_ot.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;

        update offline_time_reviews
        set status = case p_action_type when 'clarification_requested' then 'pending' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_ot.user_id, 'correction_reviewed', 'normal', 'Your offline time was reviewed',
            'Decision: ' || p_action_type || '.', 'offline_time_reviews', p_target_id,
            jsonb_build_object('kind', 'offline_time', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;

        -- § live UX review, user-directed - approving now actually
        -- applies the proposed time, not just a recorded decision.
        if p_action_type = 'approved' then
            select * into v_session from attendance_sessions where id = v_cr.attendance_session_id;
            if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;

            if v_cr.proposed_event_type = 'clock_in' then
                if v_session.clock_out_at is not null and v_cr.proposed_correct_time >= v_session.clock_out_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_in_at = v_cr.proposed_correct_time, updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_in';
            else
                if v_cr.proposed_correct_time <= v_session.clock_in_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_out_at = v_cr.proposed_correct_time, status = 'clocked_out', updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_out';

                -- Same cleanup clock_out_prosm_time_attendance's own
                -- self-service path already does - a retroactive
                -- clock-out correction shouldn't leave presence
                -- monitoring running against someone no longer "at work".
                update presence_sessions
                set status = 'ended', ended_at = now(), end_reason = 'clock_out'
                where attendance_session_id = v_cr.attendance_session_id and status = 'active';
            end if;
        end if;

        perform public.create_prosm_time_notification(
            v_caller_org, v_cr.user_id, 'correction_reviewed', 'normal', 'Your correction request was reviewed',
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id,
            jsonb_build_object('kind', 'correction', 'actionType', p_action_type)
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.list_prosm_time_report_location_violations(p_start_date date, p_end_date date)
returns table (
    flag_id uuid,
    violation_type text,
    user_full_name text,
    site_name text,
    implied_speed_kmh double precision,
    distance_meters double precision,
    occurred_at timestamptz,
    employee_reason text,
    review_status text
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_is_owner boolean;
    v_managed uuid[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    v_is_owner := public.current_prosm_time_user_is_owner();
    if not v_is_owner
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    v_managed := coalesce(public.current_prosm_time_managed_site_ids(), array[]::uuid[]);

    return query
    select * from (
        select
            lpf.id, 'implausible_location'::text, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
            lpf.implied_speed_kmh, lpf.distance_meters, lpf.occurred_at,
            null::text, null::text
        from location_plausibility_flags lpf
        join users u on u.id = lpf.user_id
        left join sites s on s.id = lpf.site_id
        where lpf.organization_id = v_org
          and lpf.occurred_at::date between p_start_date and p_end_date
          and (v_is_owner or lpf.site_id = any(v_managed))

        union all

        select
            ge.id, 'outside_work_area'::text, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
            null::double precision, ge.distance_meters, coalesce(ev.occurred_at, ge.created_at),
            ge.employee_reason, ge.status
        from geofence_exceptions ge
        join users u on u.id = ge.user_id
        left join attendance_events ev on ev.id = ge.attendance_event_id
        left join attendance_sessions ats on ats.id = ev.session_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        left join sites s on s.id = coalesce(ats.site_id, ps.site_id)
        where ge.organization_id = v_org
          and coalesce(ev.occurred_at, ge.created_at)::date between p_start_date and p_end_date
          and (v_is_owner or coalesce(ats.site_id, ps.site_id) = any(v_managed))

        union all

        select
            mlf.id, 'mock_location'::text, coalesce(u.full_name, '-'), coalesce(s.name, '-'),
            null::double precision, null::double precision, mlf.occurred_at,
            null::text, mlf.status
        from mock_location_flags mlf
        join users u on u.id = mlf.user_id
        left join sites s on s.id = mlf.site_id
        where mlf.organization_id = v_org
          and mlf.occurred_at::date between p_start_date and p_end_date
          and (v_is_owner or mlf.site_id = any(v_managed))
    ) violations
    order by 7 desc;
end;
$function$;

revoke execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean, boolean) from public, anon;
revoke execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text, boolean, boolean) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean, boolean) to authenticated, service_role;
grant execute on function public.clock_out_prosm_time_attendance(text, timestamptz, double precision, double precision, double precision, text, text, boolean, boolean) to authenticated, service_role;

commit;
