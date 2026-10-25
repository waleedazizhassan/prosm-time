-- PROSM Time v2.3.43, step 12 (item 24): clock-out when leaving the site,
-- like Connecteam's enter/leave alerts, to stop forgotten clock-outs (step 2).
-- Per site (sites.exit_policy): OFF (default) | PROMPT | AUTO.
--   PROMPT: when the person leaves the work area with the shift open, they
--     get "You left the site - clock out?" (clock out now / still working);
--   AUTO: also, after exit_auto_minutes (10 by default) outside with no
--     answer, the shift is clocked out at the real time they left, marked
--     auto_checkout_geofence; the employee and the managers are told, and a
--     manager can correct it as any record.
-- Uses the existing tracking (presence samples) - no new background service.
-- Only readings with a good accuracy count (within the site's GPS
-- tolerance), and at least two consecutive outside readings are needed, so a
-- single jump never clocks anyone out. Field workers (users.field_worker) and
-- field sites (sites.field_site) are never prompted or clocked out.
-- A policy other than OFF turns the site's presence monitoring on.
-- sites.manage_exit_policy (the Owner by default).

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('sites.manage_exit_policy', 'sites', 'ADMINISTER', 'Clock-out when leaving the site', 'Set a site''s leave-the-site prompt or automatic clock-out, and mark field workers.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'sites.manage_exit_policy'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

alter table public.sites add column if not exists exit_policy text not null default 'OFF';
alter table public.sites drop constraint if exists sites_exit_policy_check;
alter table public.sites add constraint sites_exit_policy_check check (exit_policy in ('OFF', 'PROMPT', 'AUTO'));
alter table public.sites add column if not exists exit_auto_minutes integer not null default 10 check (exit_auto_minutes between 2 and 240);
alter table public.sites add column if not exists field_site boolean not null default false;
alter table public.users add column if not exists field_worker boolean not null default false;

alter table public.presence_sessions add column if not exists exit_since timestamptz;
alter table public.presence_sessions add column if not exists exit_good_samples integer not null default 0;
alter table public.presence_sessions add column if not exists exit_prompted_at timestamptz;
alter table public.presence_sessions add column if not exists exit_dismissed_at timestamptz;
alter table public.attendance_sessions add column if not exists auto_checkout_geofence boolean not null default false;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected',
    'long_session_check', 'session_auto_closed', 'exit_site_prompt', 'auto_checkout_geofence']));

-- Clock a shift out at the moment its person left the site (AUTO).
create or replace function public.prosm_time_auto_checkout_on_exit(p_presence_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_presence presence_sessions%rowtype;
    v_session attendance_sessions%rowtype;
    v_name text;
begin
    select * into v_presence from presence_sessions where id = p_presence_session_id for update;
    select * into v_session from attendance_sessions where id = v_presence.attendance_session_id for update;
    if v_session.id is null or v_session.status <> 'clocked_in' or v_presence.exit_since is null then return false; end if;

    update attendance_sessions set status = 'clocked_out', clock_out_at = greatest(v_presence.exit_since, v_session.clock_in_at + interval '1 minute'),
        auto_checkout_geofence = true, updated_at = now()
    where id = v_session.id;
    insert into attendance_events (session_id, user_id, event_type, occurred_at, idempotency_key, geofence_checked, within_geofence, note, time_source)
    values (v_session.id, v_session.user_id, 'clock_out', greatest(v_presence.exit_since, v_session.clock_in_at + interval '1 minute'),
            'auto-exit:' || v_session.id, true, false, 'auto_checkout_geofence', 'auto_geofence')
    on conflict do nothing;
    update presence_sessions set status = 'ended', ended_at = v_presence.exit_since, end_reason = 'auto_checkout_geofence' where id = p_presence_session_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_session.organization_id, null, v_session.user_id, 'attendance.auto_checkout_geofence', 'attendance_sessions', v_session.id,
            'Clocked out automatically after leaving the site',
            jsonb_build_object('status', 'clocked_in'), jsonb_build_object('status', 'clocked_out', 'clockOutAt', v_presence.exit_since));

    select full_name into v_name from users where id = v_session.user_id;
    perform public.create_prosm_time_notification(
        v_session.organization_id, v_session.user_id, 'auto_checkout_geofence', 'normal', 'You were clocked out',
        'You left the site and were clocked out at the time you left.', 'attendance_sessions', v_session.id,
        jsonb_build_object('clockOutAt', v_presence.exit_since)
    );
    perform public.notify_prosm_time_site_managers_or_owner(
        v_session.organization_id, v_session.site_id, 'auto_checkout_geofence', 'normal', 'Clocked out on leaving the site',
        v_name || ' left the site and was clocked out automatically.', 'attendance_sessions', v_session.id,
        jsonb_build_object('kind', 'manager', 'employeeName', v_name, 'clockOutAt', v_presence.exit_since)
    );
    return true;
end;
$function$;

revoke all on function public.prosm_time_auto_checkout_on_exit(uuid) from public, anon, authenticated;

-- One sample's part in the exit rule.
create or replace function public.prosm_time_track_site_exit(p_presence_session_id uuid, p_geofence jsonb, p_accuracy_meters double precision)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_presence presence_sessions%rowtype;
    v_site sites%rowtype;
    v_field boolean;
    v_good boolean;
begin
    select * into v_presence from presence_sessions where id = p_presence_session_id;
    select * into v_site from sites where id = v_presence.site_id;
    if v_site.id is null or v_site.exit_policy = 'OFF' or v_site.field_site then return null; end if;
    select field_worker into v_field from users where id = v_presence.user_id;
    if coalesce(v_field, false) then return null; end if;
    if not coalesce((p_geofence ->> 'checked')::boolean, false) then return null; end if;

    -- a weak reading decides nothing
    v_good := p_accuracy_meters is not null and p_accuracy_meters <= greatest(coalesce(v_site.gps_accuracy_tolerance_meters, 50), 10);
    if not v_good then return jsonb_build_object('ignored', 'weak_accuracy'); end if;

    if (p_geofence ->> 'withinGeofence')::boolean then
        update presence_sessions set exit_since = null, exit_good_samples = 0, exit_prompted_at = null, exit_dismissed_at = null where id = p_presence_session_id;
        return jsonb_build_object('inside', true);
    end if;

    update presence_sessions set exit_since = coalesce(exit_since, now()), exit_good_samples = exit_good_samples + 1
    where id = p_presence_session_id
    returning * into v_presence;

    if v_presence.exit_good_samples >= 2 and v_presence.exit_prompted_at is null then
        update presence_sessions set exit_prompted_at = now() where id = p_presence_session_id;
        perform public.create_prosm_time_notification(
            v_presence.organization_id, v_presence.user_id, 'exit_site_prompt', 'high', 'You left the site',
            'You left the site - clock out?', 'attendance_sessions', v_presence.attendance_session_id,
            jsonb_build_object('siteName', v_site.name, 'policy', v_site.exit_policy, 'autoMinutes', v_site.exit_auto_minutes)
        );
        return jsonb_build_object('prompted', true, 'policy', v_site.exit_policy);
    end if;

    if v_site.exit_policy = 'AUTO' and v_presence.exit_prompted_at is not null and v_presence.exit_dismissed_at is null
       and now() - v_presence.exit_since >= make_interval(mins => v_site.exit_auto_minutes) then
        return jsonb_build_object('autoCheckout', public.prosm_time_auto_checkout_on_exit(p_presence_session_id));
    end if;
    return jsonb_build_object('outsideSince', v_presence.exit_since);
end;
$function$;

revoke all on function public.prosm_time_track_site_exit(uuid, jsonb, double precision) from public, anon, authenticated;

-- The job: samples may stop arriving once the person is away.
create or replace function public.process_prosm_time_site_exits()
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_id uuid;
    v_count integer := 0;
begin
    for v_id in
        select p.id from presence_sessions p
        join sites s on s.id = p.site_id
        join users u on u.id = p.user_id
        where p.status = 'active' and s.exit_policy = 'AUTO' and not s.field_site and not u.field_worker
          and p.exit_prompted_at is not null and p.exit_dismissed_at is null and p.exit_since is not null
          and now() - p.exit_since >= make_interval(mins => s.exit_auto_minutes)
    loop
        if public.prosm_time_auto_checkout_on_exit(v_id) then v_count := v_count + 1; end if;
    end loop;
    return v_count;
end;
$function$;

revoke all on function public.process_prosm_time_site_exits() from public, anon, authenticated;
grant execute on function public.process_prosm_time_site_exits() to service_role, postgres;

do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'prosm-time-site-exits';
exception
    when undefined_table then null;
end $$;
select cron.schedule('prosm-time-site-exits', '*/5 * * * *', $$select public.process_prosm_time_site_exits();$$);

-- The employee: "still working" to the prompt (clocking out uses the normal clock-out).
create or replace function public.respond_prosm_time_site_exit(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action <> 'still_working' then raise exception 'INVALID ACTION'; end if;
    update presence_sessions set exit_dismissed_at = now()
    where user_id = v_caller and status = 'active' and exit_since is not null;
    if not found then raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN'; end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description)
    values (public.current_prosm_time_organization_id(), v_caller, v_caller, 'attendance.exit_still_working', 'presence_sessions',
            'Answered "still working" after leaving the site');
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.respond_prosm_time_site_exit(text) from public, anon;
grant execute on function public.respond_prosm_time_site_exit(text) to authenticated;

create or replace function public.set_prosm_time_site_exit_policy(p_site_id uuid, p_policy text, p_auto_minutes integer, p_field_site boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_site sites%rowtype;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_site from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id();
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(v_caller, 'sites.manage_exit_policy') and p_site_id = any(public.current_prosm_time_managed_site_ids()))
    ) then
        raise exception 'SITES.MANAGE_EXIT_POLICY AUTHORITY REQUIRED';
    end if;
    if p_policy not in ('OFF', 'PROMPT', 'AUTO') then raise exception 'INVALID EXIT POLICY'; end if;
    begin
        update sites set exit_policy = p_policy, exit_auto_minutes = coalesce(p_auto_minutes, exit_auto_minutes),
            field_site = coalesce(p_field_site, field_site),
            presence_monitoring_enabled = presence_monitoring_enabled or p_policy <> 'OFF', updated_at = now()
        where id = p_site_id;
    exception when check_violation then raise exception 'INVALID EXIT POLICY';
    end;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_site.organization_id, v_caller, 'sites.exit_policy', 'sites', p_site_id, 'Leaving-the-site policy changed',
            jsonb_build_object('policy', v_site.exit_policy, 'autoMinutes', v_site.exit_auto_minutes, 'fieldSite', v_site.field_site),
            jsonb_build_object('policy', p_policy, 'autoMinutes', p_auto_minutes, 'fieldSite', p_field_site));
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.set_prosm_time_field_worker(p_user_id uuid, p_field_worker boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from users where id = p_user_id and organization_id = public.current_prosm_time_organization_id()) then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(v_caller, 'sites.manage_exit_policy') and public.prosm_time_caller_has_authority_over(p_user_id))
    ) then
        raise exception 'SITES.MANAGE_EXIT_POLICY AUTHORITY REQUIRED';
    end if;
    update users set field_worker = coalesce(p_field_worker, false), updated_at = now() where id = p_user_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (public.current_prosm_time_organization_id(), v_caller, p_user_id, 'employees.field_worker', 'users', p_user_id, 'Field worker flag changed',
            jsonb_build_object('fieldWorker', coalesce(p_field_worker, false)));
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.set_prosm_time_site_exit_policy(uuid, text, integer, boolean) from public, anon;
revoke all on function public.set_prosm_time_field_worker(uuid, boolean) from public, anon;
grant execute on function public.set_prosm_time_site_exit_policy(uuid, text, integer, boolean) to authenticated;
grant execute on function public.set_prosm_time_field_worker(uuid, boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.record_prosm_time_presence_sample(p_presence_session_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_session presence_sessions%rowtype;
    v_sample_id uuid;
    v_geofence jsonb;
    v_exception_created boolean := false;
    v_distance_meters double precision;
    v_effective_radius_meters double precision;
    v_violation_result jsonb;
    v_exit jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_latitude is null or p_longitude is null then
        raise exception 'LATITUDE AND LONGITUDE ARE REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS NOT ACTIVE';
    end if;

    -- § real gap fix, 14-point live-audit - run against prior samples
    -- BEFORE inserting this one below, so "previous" never means
    -- itself. Never blocks - see this migration's own header comment.
    perform public.check_prosm_time_location_plausibility(
        v_caller_id, v_session.organization_id, v_session.site_id, p_latitude, p_longitude, now(),
        'presence_sessions', p_presence_session_id
    );

    insert into location_samples (presence_session_id, user_id, latitude, longitude, accuracy_meters, client_reported_at)
    values (p_presence_session_id, v_caller_id, p_latitude, p_longitude, p_accuracy_meters, p_client_reported_at)
    returning id into v_sample_id;

    if v_session.site_id is not null then
        v_geofence := public.compute_prosm_time_geofence_check(v_session.site_id, p_latitude, p_longitude, p_accuracy_meters);
    else
        v_distance_meters := 6371000 * 2 * asin(sqrt(
            power(sin(radians(p_latitude - v_session.anchor_latitude) / 2), 2) +
            cos(radians(v_session.anchor_latitude)) * cos(radians(p_latitude)) *
            power(sin(radians(p_longitude - v_session.anchor_longitude) / 2), 2)
        ));
        v_effective_radius_meters := v_session.radius_meters + coalesce(p_accuracy_meters, 0);
        v_geofence := jsonb_build_object(
            'checked', true,
            'withinGeofence', v_distance_meters <= v_effective_radius_meters,
            'distanceMeters', v_distance_meters,
            'allowedRadiusMeters', v_session.radius_meters,
            'effectiveRadiusMeters', v_effective_radius_meters
        );
    end if;

    -- Owner 2026-10-18: one reason request per time outside the work area.
    -- Leaving the area (inside -> outside) opens one exception - or adopts
    -- the one the clock-in already made for this same time outside - and
    -- nothing more is asked while the person stays outside, even after a
    -- manager has reviewed it. Coming back inside ends it; only leaving
    -- again asks again.
    if coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = false then
        if v_session.outside_since is null then
            if not exists (
                select 1 from geofence_exceptions
                where user_id = v_caller_id
                  and created_at >= coalesce(v_session.last_inside_at, v_session.started_at) - interval '1 minute'
            ) then
                v_violation_result := public.handle_prosm_time_geofence_violation(
                    v_session.organization_id, v_caller_id, (v_geofence->>'distanceMeters')::double precision,
                    p_presence_session_id => p_presence_session_id, p_site_id => v_session.site_id
                );
                v_exception_created := coalesce((v_violation_result->>'exceptionCreated')::boolean, false);
            end if;
            update presence_sessions set outside_since = now() where id = p_presence_session_id;
        end if;
    elsif coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = true then
        update presence_sessions set outside_since = null, last_inside_at = now() where id = p_presence_session_id;
    end if;

    -- Step 12 (item 24): leaving the site with the shift still open.
    v_exit := public.prosm_time_track_site_exit(p_presence_session_id, v_geofence, p_accuracy_meters);

    return jsonb_build_object(
        'success', true, 'sampleId', v_sample_id,
        'geofence', v_geofence, 'exceptionCreated', v_exception_created, 'exit', v_exit
    );
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

commit;
