-- PROSM Time v2.3.43, step 1 (item 10): a Manager (or anyone the Owner
-- grants attendance.override_block) is no longer refused by the site's
-- self-service blocks at a site they manage:
--   * "block self clock-in after the grace period" (CLOCK_IN_BLOCKED_CONTACT_MANAGER)
--   * "outside the work area" policy BLOCK (CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER)
-- The clock-in goes through and is written to audit_logs as
-- 'attendance.override_block' (actor = subject = the caller, with which
-- block was passed, the site and the distance).
--
-- The Owner still does not clock in or out (owner decision 2026-10-18,
-- 20261018120000) - see DECISIONS.md D-01.
--
-- Out-of-zone policy per site: sites.outside_zone_policy
--   ALLOW_WITH_EXCEPTION (default) - the clock-in is recorded and the
--     existing geofence_exception path asks the employee for a reason;
--   BLOCK - a self clock-in from outside is refused (exempt employees and
--     holders of attendance.override_block at that site still may).
-- It replaces the old boolean block_self_clock_in_outside_geofence, which
-- stays in sync (a trigger) for builds released before this change.
--
-- Clock-out outside the work area is always ALLOWED with an exception:
-- block_self_clock_out_outside_geofence no longer blocks (blocking made
-- people forget to clock out - the 60-hour sessions). The column is kept
-- (old builds still send it) and set to false.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('attendance.override_block', 'attendance', 'EXECUTE', 'Override clock-in blocks',
        'Clock in at a site one manages even after the grace period or from outside the work area. Every override is audited.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'attendance.override_block'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

alter table public.sites add column if not exists outside_zone_policy text not null default 'ALLOW_WITH_EXCEPTION';
alter table public.sites drop constraint if exists sites_outside_zone_policy_check;
alter table public.sites add constraint sites_outside_zone_policy_check check (outside_zone_policy in ('ALLOW_WITH_EXCEPTION', 'BLOCK'));

update public.sites set outside_zone_policy = case when block_self_clock_in_outside_geofence then 'BLOCK' else 'ALLOW_WITH_EXCEPTION' end;
update public.sites set block_self_clock_out_outside_geofence = false where block_self_clock_out_outside_geofence;

-- Keep the old boolean and the new policy saying the same thing, whichever
-- one a client writes.
create or replace function public.prosm_time_sync_outside_zone_policy()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
    if tg_op = 'UPDATE' and new.outside_zone_policy is distinct from old.outside_zone_policy then
        new.block_self_clock_in_outside_geofence := new.outside_zone_policy = 'BLOCK';
    elsif tg_op = 'UPDATE' and new.block_self_clock_in_outside_geofence is distinct from old.block_self_clock_in_outside_geofence then
        new.outside_zone_policy := case when new.block_self_clock_in_outside_geofence then 'BLOCK' else 'ALLOW_WITH_EXCEPTION' end;
    elsif tg_op = 'INSERT' then
        new.block_self_clock_in_outside_geofence := new.outside_zone_policy = 'BLOCK';
    end if;
    new.block_self_clock_out_outside_geofence := false;
    return new;
end;
$function$;

drop trigger if exists prosm_time_sync_outside_zone_policy on public.sites;
create trigger prosm_time_sync_outside_zone_policy
before insert or update on public.sites
for each row execute function public.prosm_time_sync_outside_zone_policy();

-- Does the caller hold attendance.override_block for this site?
-- The Owner always; anyone else only at a site they manage.
create or replace function public.prosm_time_caller_can_override_block(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select p_site_id is not null
        and public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'attendance.override_block')
        and (
            public.current_prosm_time_user_is_owner()
            or p_site_id = any(public.current_prosm_time_managed_site_ids())
        );
$function$;

revoke execute on function public.prosm_time_caller_can_override_block(uuid) from public, anon, authenticated;
revoke execute on function public.prosm_time_sync_outside_zone_policy() from public, anon, authenticated;

-- The Owner or the site's own manager sets the policy (same authority as
-- set_prosm_time_site_block_clock_in_outside, which now writes it too).
create or replace function public.set_prosm_time_site_outside_zone_policy(p_site_id uuid, p_policy text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_site sites%rowtype;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_policy not in ('ALLOW_WITH_EXCEPTION', 'BLOCK') then raise exception 'INVALID OUTSIDE ZONE POLICY'; end if;
    select * into v_site from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id();
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (
            'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and p_site_id = any(public.current_prosm_time_managed_site_ids())
        )
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE';
    end if;
    if v_site.outside_zone_policy = p_policy then
        return jsonb_build_object('success', true, 'policy', p_policy);
    end if;
    update sites set outside_zone_policy = p_policy, updated_at = now() where id = p_site_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_site.organization_id, public.current_prosm_time_user_id(), 'site.outside_zone_policy', 'sites', p_site_id,
            'Out-of-zone clock-in policy changed', jsonb_build_object('policy', v_site.outside_zone_policy), jsonb_build_object('policy', p_policy));
    return jsonb_build_object('success', true, 'policy', p_policy);
end;
$function$;

revoke execute on function public.set_prosm_time_site_outside_zone_policy(uuid, text) from public, anon;
grant execute on function public.set_prosm_time_site_outside_zone_policy(uuid, text) to authenticated;


create or replace function public.clock_in_prosm_time_attendance(
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
    v_can_override boolean := false;
    v_overrides text[] := array[]::text[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    -- Owner 2026-10-18: attendance is recorded for the people below the
    -- Owner only - the Owner does not clock in or out.
    if public.current_prosm_time_user_is_owner() then
        raise exception 'THE OWNER DOES NOT CLOCK IN OR OUT';
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

        -- Step 1 (item 10): a holder of attendance.override_block at this
        -- site passes the self-service blocks; the override is audited below.
        v_can_override := public.prosm_time_caller_can_override_block(p_site_id);

        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then
                if not v_can_override then
                    raise exception 'CLOCK_IN_BLOCKED_CONTACT_MANAGER';
                end if;
                v_overrides := array_append(v_overrides, 'after_grace');
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

    -- Audit 2.1 (owner decision 2026-10-13, option a) - the site may refuse
    -- a self clock-in from outside its work area (exempt employees still
    -- may), like the clock-out setting; a manager can clock them in.
    if v_site.id is not null
        and v_site.outside_zone_policy = 'BLOCK'
        and not coalesce(v_is_exempt, false)
        and coalesce((v_geofence->>'checked')::boolean, false)
        and (v_geofence->>'withinGeofence')::boolean = false
    then
        if not v_can_override then
            raise exception 'CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER';
        end if;
        v_overrides := array_append(v_overrides, 'outside_zone');
    end if;

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

    if cardinality(v_overrides) > 0 then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, new_state, context)
        values (
            v_caller_org, v_caller_id, v_caller_id, 'attendance.override_block', 'attendance_sessions', v_session_id,
            'Clock-in past a site block with manager authority', array_to_string(v_overrides, ','),
            jsonb_build_object('status', 'clocked_in', 'clockInAt', v_effective_time),
            jsonb_build_object('siteId', p_site_id, 'blocks', to_jsonb(v_overrides), 'distanceMeters', v_geofence->'distanceMeters',
                               'latitude', p_latitude, 'longitude', p_longitude, 'accuracyMeters', p_accuracy_meters)
        );
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false, 'overrides', to_jsonb(v_overrides),
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

    -- Step 1 (item 10): clock-out outside the work area is never refused -
    -- it is recorded and the geofence exception below asks for a reason.

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


commit;
