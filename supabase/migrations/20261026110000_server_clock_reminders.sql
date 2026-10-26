-- v2.3.48 (owner 2026-10-26: "the reminder to clock in only showed when I
-- opened the app"): the phone's own scheduled reminder can be held back by
-- Android while the app is closed (exact alarms not allowed, battery
-- restrictions). The server now sends the same reminders as push
-- notifications, which arrive with the app closed:
--   * clock in  - 5 minutes before a scheduled shift starts, if the person
--                 has not clocked in and is not on approved leave that day;
--   * clock out - 10 minutes after the shift (or, without a shift, the
--                 site's end time) if the person is still clocked in.
-- Each is sent once (clock_reminder_log), in the site's own time zone, never
-- to the Owner, and not for an organisation whose trial has ended. The
-- times match the app's own reminders (clockReminders.ts).

begin;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected',
    'long_session_check', 'session_auto_closed', 'exit_site_prompt', 'auto_checkout_geofence',
    'clock_in_reminder', 'clock_out_reminder']));

create table if not exists public.clock_reminder_log (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    kind text not null check (kind in ('clock_in', 'clock_out')),
    ref_id uuid not null,
    sent_at timestamptz not null default now(),
    unique (kind, ref_id)
);
alter table public.clock_reminder_log enable row level security;
-- written and read only by the server job (no policy: members see nothing)
revoke all on public.clock_reminder_log from anon, authenticated;
create index if not exists clock_reminder_log_sent_at_idx on public.clock_reminder_log (sent_at);

create or replace function public.process_prosm_time_clock_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row record;
    v_in integer := 0;
    v_out integer := 0;
begin
    -- 1. Clock in: a scheduled shift starting in the next few minutes.
    for v_row in
        select sa.id, sa.organization_id, sa.user_id, sa.start_time, s.name as site_name,
               ((sa.shift_date + sa.start_time) at time zone public.prosm_time_site_timezone(sa.site_id, sa.organization_id)) as starts_at
        from shift_assignments sa
        join sites s on s.id = sa.site_id
        join users u on u.id = sa.user_id
        where sa.status = 'scheduled'
          and u.is_active and not u.is_owner
          and sa.shift_date between current_date - 1 and current_date + 1
          and not public.prosm_time_org_locked(sa.organization_id)
    loop
        continue when not (now() >= v_row.starts_at - interval '5 minutes' and now() < v_row.starts_at + interval '15 minutes');
        continue when exists (select 1 from clock_reminder_log l where l.kind = 'clock_in' and l.ref_id = v_row.id);
        -- already clocked in (an open session, or one begun around this shift)
        continue when exists (
            select 1 from attendance_sessions a
            where a.user_id = v_row.user_id
              and (a.status = 'clocked_in' or a.clock_in_at >= v_row.starts_at - interval '3 hours')
        );
        -- on approved leave that day
        continue when exists (
            select 1 from leave_requests lr
            where lr.user_id = v_row.user_id and lr.status = 'approved'
              and (v_row.starts_at at time zone public.prosm_time_site_timezone(null, v_row.organization_id))::date between lr.start_date and lr.end_date
        );
        insert into clock_reminder_log (organization_id, user_id, kind, ref_id) values (v_row.organization_id, v_row.user_id, 'clock_in', v_row.id)
        on conflict do nothing;
        perform public.create_prosm_time_notification(
            v_row.organization_id, v_row.user_id, 'clock_in_reminder', 'normal', 'Time to clock in',
            'Your shift at ' || v_row.site_name || ' starts at ' || to_char(v_row.start_time, 'HH24:MI') || '. Clock in when you arrive.',
            'shift_assignments', v_row.id,
            jsonb_build_object('time', to_char(v_row.start_time, 'HH24:MI'), 'siteName', v_row.site_name)
        );
        v_in := v_in + 1;
    end loop;

    -- 2. Clock out: still clocked in a little after the shift (or the site's day) ended.
    for v_row in
        select a.id, a.organization_id, a.user_id, a.clock_in_at, a.site_id,
               coalesce(sa.end_time, s.shift_end_time) as end_time,
               public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) as work_date,
               public.prosm_time_site_timezone(a.site_id, a.organization_id) as tz
        from attendance_sessions a
        join users u on u.id = a.user_id
        left join sites s on s.id = a.site_id
        left join lateral (
            select x.start_time, x.end_time from shift_assignments x
            where x.user_id = a.user_id and x.status = 'scheduled'
              and x.shift_date = public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id)
            order by x.start_time limit 1
        ) sa on true
        where a.status = 'clocked_in'
          and u.is_active and not u.is_owner
          and not public.prosm_time_org_locked(a.organization_id)
    loop
        continue when v_row.end_time is null;
        continue when exists (select 1 from clock_reminder_log l where l.kind = 'clock_out' and l.ref_id = v_row.id);
        declare
            v_end timestamptz := (v_row.work_date + v_row.end_time) at time zone v_row.tz;
        begin
            -- a shift past midnight ends the next day
            if v_end <= v_row.clock_in_at then
                v_end := v_end + interval '1 day';
            end if;
            continue when not (now() >= v_end + interval '10 minutes' and now() < v_end + interval '6 hours');
            insert into clock_reminder_log (organization_id, user_id, kind, ref_id) values (v_row.organization_id, v_row.user_id, 'clock_out', v_row.id)
            on conflict do nothing;
            perform public.create_prosm_time_notification(
                v_row.organization_id, v_row.user_id, 'clock_out_reminder', 'normal', 'Don''t forget to clock out',
                'Your shift ended at ' || to_char(v_row.end_time, 'HH24:MI') || '. Clock out in PROSM Time when you leave.',
                'attendance_sessions', v_row.id,
                jsonb_build_object('time', to_char(v_row.end_time, 'HH24:MI'))
            );
            v_out := v_out + 1;
        end;
    end loop;

    -- the log is only needed for a while
    delete from clock_reminder_log where sent_at < now() - interval '14 days';

    return jsonb_build_object('clockIn', v_in, 'clockOut', v_out);
end;
$function$;

revoke all on function public.process_prosm_time_clock_reminders() from public, anon, authenticated;

select cron.schedule('prosm-time-clock-reminders', '*/5 * * * *', $$select public.process_prosm_time_clock_reminders();$$);

commit;
