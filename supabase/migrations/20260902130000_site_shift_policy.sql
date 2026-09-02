-- PROSM Time - Feature 1 of the approved "Site Shift Policy +
-- Allowances" plan (2026-09-02). User's own description: per-site
-- work hours (from-to), an hour after which overtime starts, an hour
-- after which a lateness deduction starts, a grace period (the
-- existing grace_tolerance_minutes, never exposed in any UI until
-- now), whether break time rounds to a full locked hour or stays
-- cumulative, and whether an employee can still self-clock-in past
-- the grace period or must be told to contact their manager (who
-- then performs a justified on-behalf clock-in -
-- admin_clock_in_prosm_time_attendance already has a required
-- p_reason, so that half needed no change).
--
-- All six new sites columns are nullable/default-off, so a site with
-- no shift policy configured behaves exactly as it does today - this
-- is purely additive.

begin;

alter table public.sites
    add column shift_start_time time,
    add column shift_end_time time,
    add column overtime_start_time time,
    add column late_deduction_start_time time,
    add column break_rounding_mode text not null default 'cumulative' check (break_rounding_mode in ('cumulative', 'full_hour')),
    add column block_self_clock_in_after_grace boolean not null default false;

alter table public.timesheets
    add column total_deduction_minutes double precision not null default 0;

-- ============================================================
-- 1. create_prosm_time_site / update_prosm_time_site - six new
--    trailing params, same "drop the exact old signature, create the
--    extended one" convention already used twice this session
--    (20260902110000, 20260902120000).
-- ============================================================

drop function if exists public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer);

create function public.create_prosm_time_site(
    p_name text,
    p_latitude double precision,
    p_longitude double precision,
    p_display_address text default null,
    p_allowed_radius_meters integer default 100,
    p_gps_accuracy_tolerance_meters integer default 50,
    p_timezone text default 'UTC',
    p_attendance_allowed boolean default true,
    p_geofence_required boolean default true,
    p_camera_required boolean default false,
    p_kiosk_mode text default 'personal_device_only',
    p_environmental_tag_enabled boolean default false,
    p_grace_tolerance_minutes integer default 5,
    p_shift_start_time time default null,
    p_shift_end_time time default null,
    p_overtime_start_time time default null,
    p_late_deduction_start_time time default null,
    p_break_rounding_mode text default 'cumulative',
    p_block_self_clock_in_after_grace boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CREATE A NEW SITE';
    end if;

    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'SITE NAME IS REQUIRED';
    end if;

    if p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    insert into sites (
        organization_id, name, display_address, latitude, longitude,
        allowed_radius_meters, gps_accuracy_tolerance_meters, timezone,
        attendance_allowed, geofence_required, camera_required,
        kiosk_mode, environmental_tag_enabled, grace_tolerance_minutes,
        shift_start_time, shift_end_time, overtime_start_time, late_deduction_start_time,
        break_rounding_mode, block_self_clock_in_after_grace
    ) values (
        v_caller_org, trim(p_name), p_display_address, p_latitude, p_longitude,
        p_allowed_radius_meters, p_gps_accuracy_tolerance_meters, p_timezone,
        p_attendance_allowed, p_geofence_required, p_camera_required,
        p_kiosk_mode, p_environmental_tag_enabled, p_grace_tolerance_minutes,
        p_shift_start_time, p_shift_end_time, p_overtime_start_time, p_late_deduction_start_time,
        p_break_rounding_mode, p_block_self_clock_in_after_grace
    )
    returning id into v_site_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (
        v_caller_org, v_caller_id, 'SITE_CREATED', 'sites', v_site_id,
        'Site ' || trim(p_name) || ' created.',
        jsonb_build_object('name', trim(p_name), 'latitude', p_latitude, 'longitude', p_longitude, 'allowedRadiusMeters', p_allowed_radius_meters)
    );

    return jsonb_build_object('success', true, 'siteId', v_site_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean) from public, anon;
grant execute on function public.create_prosm_time_site(text, double precision, double precision, text, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, time, time, time, time, text, boolean) to authenticated;

drop function if exists public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean);

create function public.update_prosm_time_site(
    p_site_id uuid,
    p_name text default null,
    p_display_address text default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_allowed_radius_meters integer default null,
    p_gps_accuracy_tolerance_meters integer default null,
    p_timezone text default null,
    p_attendance_allowed boolean default null,
    p_geofence_required boolean default null,
    p_camera_required boolean default null,
    p_kiosk_mode text default null,
    p_environmental_tag_enabled boolean default null,
    p_grace_tolerance_minutes integer default null,
    p_is_active boolean default null,
    p_shift_start_time time default null,
    p_shift_end_time time default null,
    p_overtime_start_time time default null,
    p_late_deduction_start_time time default null,
    p_break_rounding_mode text default null,
    p_block_self_clock_in_after_grace boolean default null,
    p_clear_shift_policy boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_site sites%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            'sites.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            and p_site_id = any(public.current_prosm_time_managed_site_ids())
        )
    ) then
        raise exception 'SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE';
    end if;

    select * into v_site from sites where id = p_site_id and organization_id = v_caller_org;
    if v_site.id is null then
        raise exception 'SITE NOT FOUND';
    end if;

    if p_break_rounding_mode is not null and p_break_rounding_mode not in ('cumulative', 'full_hour') then
        raise exception 'INVALID BREAK ROUNDING MODE';
    end if;

    update sites set
        name = coalesce(p_name, name),
        display_address = coalesce(p_display_address, display_address),
        latitude = coalesce(p_latitude, latitude),
        longitude = coalesce(p_longitude, longitude),
        allowed_radius_meters = coalesce(p_allowed_radius_meters, allowed_radius_meters),
        gps_accuracy_tolerance_meters = coalesce(p_gps_accuracy_tolerance_meters, gps_accuracy_tolerance_meters),
        timezone = coalesce(p_timezone, timezone),
        attendance_allowed = coalesce(p_attendance_allowed, attendance_allowed),
        geofence_required = coalesce(p_geofence_required, geofence_required),
        camera_required = coalesce(p_camera_required, camera_required),
        kiosk_mode = coalesce(p_kiosk_mode, kiosk_mode),
        environmental_tag_enabled = coalesce(p_environmental_tag_enabled, environmental_tag_enabled),
        grace_tolerance_minutes = coalesce(p_grace_tolerance_minutes, grace_tolerance_minutes),
        is_active = coalesce(p_is_active, is_active),
        -- p_clear_shift_policy lets the admin explicitly blank out an
        -- already-configured shift policy (time columns have no
        -- "unset" sentinel distinct from coalesce's own null-means-
        -- keep-current default) rather than only ever being able to
        -- replace one time with another.
        shift_start_time = case when p_clear_shift_policy then null else coalesce(p_shift_start_time, shift_start_time) end,
        shift_end_time = case when p_clear_shift_policy then null else coalesce(p_shift_end_time, shift_end_time) end,
        overtime_start_time = case when p_clear_shift_policy then null else coalesce(p_overtime_start_time, overtime_start_time) end,
        late_deduction_start_time = case when p_clear_shift_policy then null else coalesce(p_late_deduction_start_time, late_deduction_start_time) end,
        break_rounding_mode = coalesce(p_break_rounding_mode, break_rounding_mode),
        block_self_clock_in_after_grace = case when p_clear_shift_policy then false else coalesce(p_block_self_clock_in_after_grace, block_self_clock_in_after_grace) end,
        updated_at = now()
    where id = p_site_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_caller_org, v_caller_id, 'SITE_UPDATED', 'sites', p_site_id, 'Site ' || v_site.name || ' updated.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'UPDATE PROSM TIME SITE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean) from public, anon;
grant execute on function public.update_prosm_time_site(uuid, text, text, double precision, double precision, integer, integer, text, boolean, boolean, boolean, text, boolean, integer, boolean, time, time, time, time, text, boolean, boolean) to authenticated;

-- ============================================================
-- 2. clock_in_prosm_time_attendance - the manager-assisted-only
--    block. Checked in the site's own timezone against
--    shift_start_time + the existing grace_tolerance_minutes (never
--    used for lateness anywhere until now, despite its own migration
--    comment already describing this exact purpose).
-- ============================================================

drop function if exists public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null,
    p_manual_location_label text default null
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
    v_exception_id uuid;
    v_manual_label text;
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

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
        end if;

        -- § live UX review, user-directed - "after the grace period,
        -- can the employee still self clock-in, or does it say
        -- contact your manager?" A site with the toggle on and a
        -- configured shift start simply refuses self clock-in past
        -- shift_start_time + grace_tolerance_minutes (site-local
        -- time) - the frontend recognizes this exact marker string
        -- and shows "contact your manager" instead of a generic
        -- error. The Manager resolves it with the already-existing,
        -- already-site-scoped, already-reason-required
        -- admin_clock_in_prosm_time_attendance - no change needed
        -- there.
        if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null then
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

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at, manual_location_label)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', now(), v_manual_label)
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
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            (select full_name from users where id = v_caller_id) || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
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

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text) to authenticated;

-- ============================================================
-- 3. generate_prosm_time_timesheet - a per-day site policy now also
--    carries overtime_start_time/late_deduction_start_time/timezone;
--    when the day's site has overtime_start_time configured, that
--    clock-time-based figure REPLACES the existing duration-threshold
--    overtime for that day (the admin's explicit configuration wins);
--    a site with no shift policy keeps today's exact duration-
--    threshold behavior. total_deduction_minutes is new and purely
--    additive - lateness past late_deduction_start_time, in the
--    site's own local time.
-- ============================================================

create or replace function public.generate_prosm_time_timesheet(
    p_user_id uuid,
    p_period_start date,
    p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_deduction_minutes double precision := 0;
    v_exceptions_count integer := 0;
    v_corrections_count integer := 0;
    v_timesheet_id uuid;
    v_existing_status text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_period_end < p_period_start then raise exception 'PERIOD END MUST NOT BE BEFORE PERIOD START'; end if;

    select organization_id into v_org_id from users where id = p_user_id;
    if v_org_id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_org_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE';
    end if;

    select id, status into v_timesheet_id, v_existing_status
    from timesheets where user_id = p_user_id and period_start = p_period_start and period_end = p_period_end;

    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    with worked_by_day as (
        select
            ats.clock_in_at::date as work_date,
            sum(extract(epoch from (coalesce(ats.clock_out_at, now()) - ats.clock_in_at)) / 60) as worked_minutes
        from attendance_sessions ats
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
        group by ats.clock_in_at::date
    ),
    unpaid_breaks_by_day as (
        select
            ats.clock_in_at::date as work_date,
            sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60) as unpaid_break_minutes
        from break_events be
        join attendance_sessions ats on ats.id = be.attendance_session_id
        where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end and be.paid = false
        group by ats.clock_in_at::date
    ),
    threshold_by_day as (
        select distinct on (ats.clock_in_at::date)
            ats.clock_in_at::date as work_date,
            s.daily_overtime_threshold_minutes as site_threshold,
            s.overtime_start_time,
            s.late_deduction_start_time,
            s.timezone as site_timezone,
            ats.clock_in_at as rep_clock_in_at,
            ats.clock_out_at as rep_clock_out_at
        from attendance_sessions ats
        join sites s on s.id = ats.site_id
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
        order by ats.clock_in_at::date, ats.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(
            case
                when t.overtime_start_time is not null and t.rep_clock_out_at is not null then
                    greatest(extract(epoch from ((t.rep_clock_out_at at time zone t.site_timezone)::time - t.overtime_start_time)) / 60, 0)
                else
                    greatest(w.worked_minutes - coalesce(ub.unpaid_break_minutes, 0) - coalesce(t.site_threshold, v_org_threshold, 480), 0)
            end
        ), 0),
        coalesce(sum(
            case
                when t.late_deduction_start_time is not null then
                    greatest(extract(epoch from ((t.rep_clock_in_at at time zone t.site_timezone)::time - t.late_deduction_start_time)) / 60, 0)
                else 0
            end
        ), 0)
    into v_worked_minutes, v_overtime_minutes, v_deduction_minutes
    from worked_by_day w
    left join unpaid_breaks_by_day ub on ub.work_date = w.work_date
    left join threshold_by_day t on t.work_date = w.work_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

commit;
