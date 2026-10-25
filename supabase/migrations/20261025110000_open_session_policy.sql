-- PROSM Time v2.3.43, step 2 (item 11): open shifts no longer count for
-- days. Policy (owner-agreed):
--   * nothing closes at the end of the shift (people work 9, 12+ hours);
--   * after open_session_alert_hours (default 12): the employee is asked
--     "still working?" and the site's managers are told ONCE per shift;
--   * after open_session_max_hours (default 24): the shift is closed
--     automatically (auto_closed), its end = the last known activity (last
--     location sample, last app ping, last break) or the closing time, and
--     its hours are PENDING: they count in no timesheet, total, allowance,
--     overtime or cost until a manager reviews the shift and sets its end;
--   * a manager can extend a shift before the limit (planned long shift).
-- Shifts opened before this change are not closed automatically: they are
-- listed for review (list_prosm_time_stale_open_sessions).
-- Also: the "has not clocked out" notification is sent once per shift
-- (the 6-hourly job repeated it - 58 min and 60 h in the owner's screenshot),
-- old repeats are removed; discarding a saved offline action is audited;
-- the site summary report no longer counts a shift's hours once per event.

begin;

-- ------------------------------------------------------------------
-- Settings (per organisation)
-- ------------------------------------------------------------------
alter table public.organization_settings add column if not exists open_session_alert_hours integer not null default 12;
alter table public.organization_settings add column if not exists open_session_max_hours integer not null default 24;
alter table public.organization_settings add column if not exists open_session_policy_since timestamptz not null default now();
alter table public.organization_settings drop constraint if exists organization_settings_open_session_hours_check;
alter table public.organization_settings add constraint organization_settings_open_session_hours_check
    check (open_session_alert_hours between 1 and 71 and open_session_max_hours between 2 and 72 and open_session_alert_hours < open_session_max_hours);

-- ------------------------------------------------------------------
-- Session state
-- ------------------------------------------------------------------
alter table public.attendance_sessions add column if not exists long_session_alerted_at timestamptz;
alter table public.attendance_sessions add column if not exists still_working_at timestamptz;
alter table public.attendance_sessions add column if not exists last_activity_at timestamptz;
alter table public.attendance_sessions add column if not exists extended_until timestamptz;
alter table public.attendance_sessions add column if not exists auto_closed boolean not null default false;
alter table public.attendance_sessions add column if not exists auto_closed_at timestamptz;
alter table public.attendance_sessions add column if not exists hours_review_status text not null default 'none';
alter table public.attendance_sessions add column if not exists hours_reviewed_by uuid references public.users(id) on delete set null;
alter table public.attendance_sessions add column if not exists hours_reviewed_at timestamptz;
alter table public.attendance_sessions drop constraint if exists attendance_sessions_hours_review_status_check;
alter table public.attendance_sessions add constraint attendance_sessions_hours_review_status_check
    check (hours_review_status in ('none', 'pending', 'reviewed'));
create index if not exists attendance_sessions_pending_hours_idx on public.attendance_sessions (organization_id) where hours_review_status = 'pending';

alter table public.attendance_events drop constraint if exists attendance_events_time_source_check;
alter table public.attendance_events add constraint attendance_events_time_source_check
    check (time_source in ('server', 'device_offline', 'auto_closed', 'auto_geofence'));

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected',
    'long_session_check', 'session_auto_closed']));

-- ------------------------------------------------------------------
-- Permissions
-- ------------------------------------------------------------------
insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('sessions.review_pending', 'sessions', 'APPROVE', 'Review pending hours', 'Review automatically closed shifts, set their end, and extend a long shift, for people at the sites one manages.'),
    ('settings.session_policy', 'settings', 'ADMINISTER', 'Open-shift policy', 'Set after how many hours an open shift raises an alert and is closed automatically.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'sessions.review_pending'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'settings.session_policy'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

-- ------------------------------------------------------------------
-- Does a shift's time count? Closed and not waiting for review.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_session_counts(p_status text, p_hours_review_status text)
returns boolean
language sql
immutable
set search_path = public
as $function$
    select p_status = 'clocked_out' and coalesce(p_hours_review_status, 'none') <> 'pending';
$function$;

revoke all on function public.prosm_time_session_counts(text, text) from public, anon;
grant execute on function public.prosm_time_session_counts(text, text) to authenticated, service_role;

-- The last moment the employee was seen during this shift.
create or replace function public.prosm_time_session_last_activity(p_session_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $function$
    select greatest(
        s.clock_in_at,
        s.last_activity_at,
        s.still_working_at,
        (select max(ls.captured_at) from location_samples ls join presence_sessions ps on ps.id = ls.presence_session_id
          where ps.attendance_session_id = s.id),
        (select max(greatest(b.started_at, coalesce(b.ended_at, b.started_at))) from break_events b where b.attendance_session_id = s.id),
        (select max(e.occurred_at) from attendance_events e where e.session_id = s.id)
    )
    from attendance_sessions s where s.id = p_session_id;
$function$;

revoke execute on function public.prosm_time_session_last_activity(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- The job: alert at N hours (once), close at M hours (pending).
-- ------------------------------------------------------------------
create or replace function public.process_prosm_time_open_sessions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row record;
    v_alerted integer := 0;
    v_closed integer := 0;
    v_end timestamptz;
    v_hours numeric;
begin
    -- 1. The alert, once per shift.
    for v_row in
        select s.id, s.user_id, s.organization_id, s.site_id, s.clock_in_at, u.full_name, os.open_session_alert_hours as alert_hours
        from attendance_sessions s
        join users u on u.id = s.user_id
        join organization_settings os on os.organization_id = s.organization_id
        where s.status = 'clocked_in'
          and s.long_session_alerted_at is null
          and s.clock_in_at >= os.open_session_policy_since
          and s.clock_in_at <= now() - make_interval(hours => os.open_session_alert_hours)
          and (s.extended_until is null or now() >= s.extended_until - make_interval(hours => os.open_session_max_hours - os.open_session_alert_hours))
    loop
        update attendance_sessions set long_session_alerted_at = now() where id = v_row.id;
        perform public.create_prosm_time_notification(
            v_row.organization_id, v_row.user_id, 'long_session_check', 'normal', 'Still working?',
            'You have been clocked in for ' || v_row.alert_hours || ' hours. Still working, or clock out?',
            'attendance_sessions', v_row.id,
            jsonb_build_object('hoursSinceClockIn', v_row.alert_hours, 'clockInAt', v_row.clock_in_at)
        );
        perform public.notify_prosm_time_site_managers_or_owner(
            v_row.organization_id, v_row.site_id, 'missing_clock_out', 'normal', 'Employee has not clocked out',
            v_row.full_name || ' has been clocked in for ' || v_row.alert_hours || ' hours with no clock-out yet.',
            'attendance_sessions', v_row.id,
            jsonb_build_object('employeeName', v_row.full_name, 'clockInAt', v_row.clock_in_at, 'hoursSinceClockIn', v_row.alert_hours)
        );
        v_alerted := v_alerted + 1;
    end loop;

    -- 2. The automatic close: pending hours, waiting for a manager.
    for v_row in
        select s.id, s.user_id, s.organization_id, s.site_id, s.clock_in_at, u.full_name, os.open_session_max_hours as max_hours
        from attendance_sessions s
        join users u on u.id = s.user_id
        join organization_settings os on os.organization_id = s.organization_id
        where s.status = 'clocked_in'
          and s.clock_in_at >= os.open_session_policy_since
          and s.clock_in_at <= now() - make_interval(hours => os.open_session_max_hours)
          and (s.extended_until is null or now() >= s.extended_until)
        for update of s skip locked
    loop
        v_end := least(coalesce(public.prosm_time_session_last_activity(v_row.id), now()), now());
        if v_end <= v_row.clock_in_at then v_end := now(); end if;

        update attendance_sessions
        set status = 'clocked_out', clock_out_at = v_end, auto_closed = true, auto_closed_at = now(),
            hours_review_status = 'pending', updated_at = now()
        where id = v_row.id;

        insert into attendance_events (session_id, user_id, event_type, occurred_at, idempotency_key, geofence_checked, note, time_source)
        values (v_row.id, v_row.user_id, 'clock_out', v_end, 'auto-close:' || v_row.id, false, 'auto_closed', 'auto_closed')
        on conflict do nothing;

        update presence_sessions set status = 'ended', ended_at = v_end, end_reason = 'auto_closed'
        where attendance_session_id = v_row.id and status = 'active';

        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state, context)
        values (v_row.organization_id, null, v_row.user_id, 'attendance.auto_close', 'attendance_sessions', v_row.id,
                'Shift closed automatically - hours pending review', 'open_session_max_hours',
                jsonb_build_object('status', 'clocked_in', 'clockInAt', v_row.clock_in_at),
                jsonb_build_object('status', 'clocked_out', 'clockOutAt', v_end, 'hoursReviewStatus', 'pending'),
                jsonb_build_object('maxHours', v_row.max_hours, 'closedAt', now()));

        v_hours := round((extract(epoch from (v_end - v_row.clock_in_at)) / 3600)::numeric, 1);
        perform public.create_prosm_time_notification(
            v_row.organization_id, v_row.user_id, 'session_auto_closed', 'normal', 'Your shift was closed automatically',
            'Your shift was closed after ' || v_row.max_hours || ' hours. Its hours wait for your manager''s review.',
            'attendance_sessions', v_row.id,
            jsonb_build_object('maxHours', v_row.max_hours, 'clockInAt', v_row.clock_in_at, 'clockOutAt', v_end, 'hours', v_hours)
        );
        perform public.notify_prosm_time_site_managers_or_owner(
            v_row.organization_id, v_row.site_id, 'session_auto_closed', 'normal', 'A shift was closed automatically',
            v_row.full_name || '''s shift was closed after ' || v_row.max_hours || ' hours - review its hours.',
            'attendance_sessions', v_row.id,
            jsonb_build_object('kind', 'manager', 'employeeName', v_row.full_name, 'maxHours', v_row.max_hours, 'clockInAt', v_row.clock_in_at, 'clockOutAt', v_end, 'hours', v_hours)
        );
        v_closed := v_closed + 1;
    end loop;

    return jsonb_build_object('alerted', v_alerted, 'closed', v_closed);
end;
$function$;

revoke all on function public.process_prosm_time_open_sessions() from public, anon, authenticated;
grant execute on function public.process_prosm_time_open_sessions() to service_role, postgres;

-- The old 6-hourly job sent the notice again every run; replaced.
do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname in ('prosm-time-missing-clockout-check', 'prosm-time-open-sessions');
exception
    when undefined_table then null;
end $$;

select cron.schedule('prosm-time-open-sessions', '*/15 * * * *', $$select public.process_prosm_time_open_sessions();$$);

-- One "has not clocked out" notice per person and shift: older repeats go.
delete from public.notifications n
using public.notifications newer
where n.type = 'missing_clock_out' and newer.type = 'missing_clock_out'
  and n.user_id = newer.user_id and n.related_entity_id = newer.related_entity_id
  and (n.created_at, n.id) < (newer.created_at, newer.id);

-- Shifts that were already open count as alerted (they are reviewed from the stale list).
update public.attendance_sessions set long_session_alerted_at = coalesce(long_session_alerted_at, now())
where status = 'clocked_in' and clock_in_at < now() - interval '12 hours';

-- ------------------------------------------------------------------
-- The employee: "still working" and the app's activity ping.
-- ------------------------------------------------------------------
create or replace function public.respond_prosm_time_long_session(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_session attendance_sessions%rowtype;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action <> 'still_working' then raise exception 'INVALID ACTION'; end if;
    select * into v_session from attendance_sessions where user_id = v_caller and status = 'clocked_in';
    if v_session.id is null then raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN'; end if;
    update attendance_sessions set still_working_at = now(), last_activity_at = now(), updated_at = now() where id = v_session.id;
    return jsonb_build_object('success', true, 'sessionId', v_session.id);
end;
$function$;

revoke all on function public.respond_prosm_time_long_session(text) from public, anon;
grant execute on function public.respond_prosm_time_long_session(text) to authenticated;

create or replace function public.touch_prosm_time_session_activity()
returns void
language sql
security definer
set search_path = public
as $function$
    update attendance_sessions set last_activity_at = now()
    where user_id = public.current_prosm_time_user_id() and status = 'clocked_in'
      and (last_activity_at is null or last_activity_at < now() - interval '5 minutes');
$function$;

revoke all on function public.touch_prosm_time_session_activity() from public, anon;
grant execute on function public.touch_prosm_time_session_activity() to authenticated;

-- ------------------------------------------------------------------
-- The manager: extend a long shift, review pending hours.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_require_session_authority(p_session attendance_sessions)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_session.id is null or p_session.organization_id <> public.current_prosm_time_organization_id() then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'sessions.review_pending') then
        raise exception 'SESSIONS.REVIEW_PENDING AUTHORITY REQUIRED';
    end if;
    if p_session.user_id = v_caller then
        raise exception 'YOU CANNOT REVIEW YOUR OWN SHIFT';
    end if;
    if not public.prosm_time_caller_has_authority_over(p_session.user_id) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;
end;
$function$;

revoke all on function public.prosm_time_require_session_authority(attendance_sessions) from public, anon, authenticated;

create or replace function public.extend_prosm_time_session(p_session_id uuid, p_until timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_session attendance_sessions%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    select * into v_session from attendance_sessions where id = p_session_id;
    perform public.prosm_time_require_session_authority(v_session);
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'THIS SHIFT IS NOT OPEN'; end if;
    if p_until is null or p_until <= now() or p_until > v_session.clock_in_at + interval '72 hours' then
        raise exception 'INVALID EXTENSION TIME';
    end if;
    update attendance_sessions set extended_until = p_until, updated_at = now() where id = p_session_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_session.organization_id, public.current_prosm_time_user_id(), v_session.user_id, 'attendance.extend_session', 'attendance_sessions', p_session_id,
            'Open shift extended', v_reason, jsonb_build_object('extendedUntil', v_session.extended_until), jsonb_build_object('extendedUntil', p_until));
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.extend_prosm_time_session(uuid, timestamptz, text) from public, anon;
grant execute on function public.extend_prosm_time_session(uuid, timestamptz, text) to authenticated;

create or replace function public.review_prosm_time_pending_session(p_session_id uuid, p_clock_out_at timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_session attendance_sessions%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    select * into v_session from attendance_sessions where id = p_session_id for update;
    perform public.prosm_time_require_session_authority(v_session);
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    if v_session.hours_review_status <> 'pending' then raise exception 'THIS SHIFT IS NOT WAITING FOR REVIEW'; end if;
    if p_clock_out_at is null or p_clock_out_at <= v_session.clock_in_at or p_clock_out_at > now() then
        raise exception 'INVALID CLOCK OUT TIME';
    end if;
    if exists (
        select 1 from timesheets t
        where t.user_id = v_session.user_id and t.status in ('approved', 'locked')
          and v_session.clock_in_at::date between t.period_start and t.period_end
    ) then
        raise exception 'THE TIMESHEET FOR THIS PERIOD IS ALREADY APPROVED';
    end if;

    update attendance_sessions
    set clock_out_at = p_clock_out_at, hours_review_status = 'reviewed',
        hours_reviewed_by = public.current_prosm_time_user_id(), hours_reviewed_at = now(), updated_at = now()
    where id = p_session_id;
    update attendance_events set occurred_at = p_clock_out_at where idempotency_key = 'auto-close:' || p_session_id;
    update break_events set ended_at = least(ended_at, p_clock_out_at) where attendance_session_id = p_session_id and ended_at > p_clock_out_at;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_session.organization_id, public.current_prosm_time_user_id(), v_session.user_id, 'attendance.review_pending_hours', 'attendance_sessions', p_session_id,
            'Pending hours reviewed', v_reason,
            jsonb_build_object('clockOutAt', v_session.clock_out_at, 'hoursReviewStatus', 'pending'),
            jsonb_build_object('clockOutAt', p_clock_out_at, 'hoursReviewStatus', 'reviewed'));

    perform public.create_prosm_time_notification(
        v_session.organization_id, v_session.user_id, 'correction_reviewed', 'normal', 'Your shift''s hours were reviewed',
        'Your manager set the end of your shift.', 'attendance_sessions', p_session_id,
        jsonb_build_object('kind', 'pending_hours', 'actionType', 'approved', 'notes', v_reason)
    );
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.review_prosm_time_pending_session(uuid, timestamptz, text) from public, anon;
grant execute on function public.review_prosm_time_pending_session(uuid, timestamptz, text) to authenticated;

-- Shifts waiting for review (auto-closed), for the people one manages.
create or replace function public.list_prosm_time_pending_sessions()
returns table (session_id uuid, user_id uuid, employee_name text, avatar_url text, site_id uuid, site_name text,
               clock_in_at timestamptz, clock_out_at timestamptz, auto_closed_at timestamptz, last_activity_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'sessions.review_pending') then
        return;
    end if;
    return query
    select s.id, s.user_id, u.full_name, u.avatar_url, s.site_id, st.name, s.clock_in_at, s.clock_out_at, s.auto_closed_at,
           public.prosm_time_session_last_activity(s.id)
    from attendance_sessions s
    join users u on u.id = s.user_id
    left join sites st on st.id = s.site_id
    where s.organization_id = public.current_prosm_time_organization_id()
      and s.hours_review_status = 'pending'
      and s.user_id <> public.current_prosm_time_user_id()
      and public.prosm_time_caller_has_authority_over(s.user_id)
    order by s.clock_in_at;
end;
$function$;

revoke all on function public.list_prosm_time_pending_sessions() from public, anon;
grant execute on function public.list_prosm_time_pending_sessions() to authenticated;

-- One-off clean-up report: shifts still open for longer than the limit
-- that the automatic close does not touch (opened before this change).
create or replace function public.list_prosm_time_stale_open_sessions()
returns table (session_id uuid, user_id uuid, employee_name text, site_name text, clock_in_at timestamptz, open_hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'sessions.review_pending') then
        return;
    end if;
    return query
    select s.id, s.user_id, u.full_name, st.name, s.clock_in_at, round((extract(epoch from (now() - s.clock_in_at)) / 3600)::numeric, 1)
    from attendance_sessions s
    join users u on u.id = s.user_id
    left join sites st on st.id = s.site_id
    join organization_settings os on os.organization_id = s.organization_id
    where s.organization_id = public.current_prosm_time_organization_id()
      and s.status = 'clocked_in'
      and s.clock_in_at < os.open_session_policy_since
      and s.clock_in_at < now() - make_interval(hours => os.open_session_max_hours)
      and public.prosm_time_caller_has_authority_over(s.user_id)
    order by s.clock_in_at;
end;
$function$;

revoke all on function public.list_prosm_time_stale_open_sessions() from public, anon;
grant execute on function public.list_prosm_time_stale_open_sessions() to authenticated;

-- ------------------------------------------------------------------
-- The setting (Owner / settings.session_policy)
-- ------------------------------------------------------------------
create or replace function public.set_prosm_time_session_policy(p_alert_hours integer, p_max_hours integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_before organization_settings%rowtype;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'settings.session_policy') then
        raise exception 'SETTINGS.SESSION_POLICY AUTHORITY REQUIRED';
    end if;
    if p_alert_hours is null or p_max_hours is null or p_alert_hours < 1 or p_max_hours > 72 or p_alert_hours >= p_max_hours then
        raise exception 'INVALID OPEN SHIFT HOURS';
    end if;
    select * into v_before from organization_settings where organization_id = v_org;
    update organization_settings set open_session_alert_hours = p_alert_hours, open_session_max_hours = p_max_hours where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_org, v_caller, 'settings.session_policy', 'organization_settings', v_before.id, 'Open-shift policy changed',
            jsonb_build_object('alertHours', v_before.open_session_alert_hours, 'maxHours', v_before.open_session_max_hours),
            jsonb_build_object('alertHours', p_alert_hours, 'maxHours', p_max_hours));
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.set_prosm_time_session_policy(integer, integer) from public, anon;
grant execute on function public.set_prosm_time_session_policy(integer, integer) to authenticated;

-- ------------------------------------------------------------------
-- Discarding an action saved offline leaves a trace.
-- ------------------------------------------------------------------
create or replace function public.log_prosm_time_offline_discard(p_kind text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description, reason, context)
    values (public.current_prosm_time_organization_id(), v_caller, v_caller, 'offline.discard', 'offline_queue',
            'An action saved offline was discarded on the device', left(coalesce(p_kind, 'unknown'), 64),
            coalesce(p_detail, '{}'::jsonb) - 'photo' - 'evidence');
end;
$function$;

revoke all on function public.log_prosm_time_offline_discard(text, jsonb) from public, anon;
grant execute on function public.log_prosm_time_offline_discard(text, jsonb) to authenticated;

-- ------------------------------------------------------------------
-- Allowances: an automatically closed shift fills nothing until reviewed.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_auto_fill_allowance_on_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if (
        (new.status = 'clocked_out' and old.status is distinct from 'clocked_out' and new.hours_review_status <> 'pending')
        or (old.hours_review_status = 'pending' and new.hours_review_status = 'reviewed')
    ) and exists (select 1 from allowance_preferences p where p.user_id = new.user_id and p.auto_fill) then
        begin
            perform public.prosm_time_start_allowance_day(new.user_id, new.clock_in_at::date);
        exception when others then
            -- never let allowances block a clock-out
            null;
        end;
    end if;
    return new;
end;
$function$;

drop trigger if exists attendance_sessions_auto_fill_allowance on public.attendance_sessions;
create trigger attendance_sessions_auto_fill_allowance
after update of status, hours_review_status on public.attendance_sessions
for each row execute function public.prosm_time_auto_fill_allowance_on_clock_out();

-- ------------------------------------------------------------------
-- Timesheets count only closed, reviewed shifts (an open shift used to
-- count up to now - a forgotten one gave 100-hour weeks).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_deduction_minutes double precision := 0;
    v_leave_days numeric := 0;
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
            public.current_prosm_time_user_is_owner() or p_user_id = v_caller_id
            or (
                'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over(p_user_id)
            )
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

    with rejected_exception_cap as (
        select
            coalesce(ae.session_id, ps.attendance_session_id) as session_id,
            min(ge.created_at) as cap_at
        from geofence_exceptions ge
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        where ge.user_id = p_user_id
        and exists (
            select 1 from exception_actions ea
            where ea.geofence_exception_id = ge.id
            and ea.action_type = 'rejected'
            and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
        )
        group by coalesce(ae.session_id, ps.attendance_session_id)
    ),
    capped_sessions as (
        select
            ats.id as session_id,
            ats.clock_in_at,
            ats.site_id,
            least(ats.clock_out_at, coalesce(rec.cap_at, ats.clock_out_at)) as effective_clock_out_at
        from attendance_sessions ats
        left join rejected_exception_cap rec on rec.session_id = ats.id
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
    ),
    worked_by_day as (
        select
            cs.clock_in_at::date as work_date,
            sum(extract(epoch from (cs.effective_clock_out_at - cs.clock_in_at)) / 60) as worked_minutes
        from capped_sessions cs
        group by cs.clock_in_at::date
    ),
    threshold_by_day as (
        select distinct on (cs.clock_in_at::date)
            cs.clock_in_at::date as work_date,
            s.daily_overtime_threshold_minutes as site_threshold,
            s.overtime_start_time,
            s.late_deduction_start_time,
            s.timezone as site_timezone,
            cs.clock_in_at as rep_clock_in_at,
            cs.effective_clock_out_at as rep_clock_out_at
        from capped_sessions cs
        join sites s on s.id = cs.site_id
        order by cs.clock_in_at::date, cs.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(
            case
                when t.overtime_start_time is not null and t.rep_clock_out_at is not null then
                    greatest(extract(epoch from ((t.rep_clock_out_at at time zone t.site_timezone)::time - t.overtime_start_time)) / 60, 0)
                else
                    greatest(w.worked_minutes - coalesce(t.site_threshold, v_org_threshold, 480), 0)
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
    left join threshold_by_day t on t.work_date = w.work_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, ats.clock_out_at) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);

    select coalesce(sum(
        least(lr.end_date, p_period_end) - greatest(lr.start_date, p_period_start) + 1
    ), 0)
    into v_leave_days
    from leave_requests lr
    where lr.user_id = p_user_id
      and lr.status = 'approved'
      and lr.start_date <= p_period_end
      and lr.end_date >= p_period_start;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes, total_leave_days,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes, v_leave_days,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
        total_leave_days = excluded.total_leave_days,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    if p_user_id <> v_caller_id then
        perform public.create_prosm_time_notification(
            v_org_id, p_user_id, 'timesheet_ready', 'normal', 'Your timesheet is ready',
            'Review your timesheet for ' || p_period_start || ' - ' || p_period_end || ' and submit it.',
            'timesheets', v_timesheet_id,
            jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end)
        );
    end if;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

-- ------------------------------------------------------------------
-- Site summary report: hours per shift once (the join with events
-- counted each shift's hours once per event), closed reviewed shifts only.
-- ------------------------------------------------------------------
create or replace function public.list_prosm_time_report_site_summary(p_start_date date, p_end_date date)
returns table (
    site_id uuid,
    site_name text,
    employee_count bigint,
    total_hours numeric,
    exception_count bigint
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        s.id, s.name,
        (select count(distinct sess.user_id) from attendance_sessions sess
          where sess.site_id = s.id and sess.clock_in_at::date between p_start_date and p_end_date),
        round(coalesce((select sum(extract(epoch from (sess.clock_out_at - sess.clock_in_at))) from attendance_sessions sess
          where sess.site_id = s.id and sess.clock_in_at::date between p_start_date and p_end_date
            and public.prosm_time_session_counts(sess.status, sess.hours_review_status)) / 3600.0, 0)::numeric, 1),
        (select count(distinct ge.id) from geofence_exceptions ge
          join attendance_events ae on ae.id = ge.attendance_event_id
          join attendance_sessions sess on sess.id = ae.session_id
          where sess.site_id = s.id and sess.clock_in_at::date between p_start_date and p_end_date
            and ge.created_at::date between p_start_date and p_end_date)
    from sites s
    where s.organization_id = v_org
      and (public.current_prosm_time_user_is_owner() or s.id = any(public.current_prosm_time_managed_site_ids()))
    order by s.name;
end;
$function$;

-- ------------------------------------------------------------------
-- Dashboard: pending hours do not count; an open shift counts up to now
-- but never past the alert limit; pending shifts are "waiting".
-- ------------------------------------------------------------------
create or replace function public.get_prosm_time_dashboard_summary(p_week_start date, p_time_zone text default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_tz text := coalesce((select name from pg_timezone_names where name = p_time_zone limit 1), 'UTC');
    v_alert_hours integer := coalesce((select open_session_alert_hours from organization_settings where organization_id = v_org), 12);
    v_today date;
    v_result jsonb;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_user_has_permission_internal(v_caller, 'attendance.view')) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_today := (now() at time zone v_tz)::date;

    with team as (
        select u.id from users u
        where u.organization_id = v_org and u.is_active and not u.is_owner
          and public.prosm_time_caller_sees_person(u.id)
    ),
    present as (
        select distinct s.user_id from attendance_sessions s join team t on t.id = s.user_id
        where s.status = 'clocked_in'
    ),
    on_break as (
        select distinct b.user_id from break_events b join present p on p.user_id = b.user_id
        where b.status = 'active'
    ),
    on_leave as (
        select distinct l.user_id from leave_requests l join team t on t.id = l.user_id
        where l.status = 'approved' and v_today between l.start_date and l.end_date
          and l.user_id not in (select user_id from present)
    ),
    days as (
        select (p_week_start + i) as day from generate_series(0, 6) as i
    ),
    worked as (
        select (s.clock_in_at at time zone v_tz)::date as day,
               sum(extract(epoch from (
                   case when s.status = 'clocked_in' then least(now(), s.clock_in_at + make_interval(hours => v_alert_hours)) else s.clock_out_at end
                   - s.clock_in_at)) / 60) as minutes
        from attendance_sessions s
        where s.organization_id = v_org
          and s.hours_review_status <> 'pending'
          and s.clock_in_at >= (p_week_start::timestamp at time zone v_tz)
          and s.clock_in_at < ((p_week_start + 7)::timestamp at time zone v_tz)
          and (public.current_prosm_time_user_is_owner() or public.prosm_time_caller_sees_person(s.user_id))
        group by 1
    ),
    decidable as (
        select user_id from geofence_exceptions where organization_id = v_org and status = 'pending_review'
        union all select user_id from correction_requests where organization_id = v_org and status = 'pending'
        union all select user_id from offline_time_reviews where organization_id = v_org and status = 'pending'
        union all select user_id from mock_location_flags where organization_id = v_org and status = 'pending_review'
        union all select user_id from leave_requests where organization_id = v_org and status = 'pending'
        union all select user_id from timesheets where organization_id = v_org and status = 'submitted'
        union all select user_id from allowance_sheets where organization_id = v_org and status = 'submitted'
        union all select user_id from attendance_sessions where organization_id = v_org and hours_review_status = 'pending'
    )
    select jsonb_build_object(
        'team', (select count(*) from team),
        'present', (select count(*) from present),
        'onBreak', (select count(*) from on_break),
        'onLeave', (select count(*) from on_leave),
        'absent', greatest(0, (select count(*) from team) - (select count(*) from present) - (select count(*) from on_leave)),
        'waiting', (select count(*) from decidable d where d.user_id <> v_caller and public.prosm_time_caller_has_authority_over(d.user_id)),
        'pendingSessions', (select count(*) from attendance_sessions s where s.organization_id = v_org and s.hours_review_status = 'pending'
                              and s.user_id <> v_caller and public.prosm_time_caller_has_authority_over(s.user_id)),
        'longSessions', (select count(*) from attendance_sessions s where s.organization_id = v_org and s.status = 'clocked_in'
                              and s.clock_in_at <= now() - make_interval(hours => v_alert_hours)
                              and (public.current_prosm_time_user_is_owner() or public.prosm_time_caller_sees_person(s.user_id))),
        'week', (select jsonb_agg(jsonb_build_object('day', d.day, 'minutes', round(coalesce(w.minutes, 0)::numeric)) order by d.day)
                 from days d left join worked w on w.day = d.day),
        'asOf', now()
    ) into v_result;

    return v_result;
end;
$function$;

commit;
