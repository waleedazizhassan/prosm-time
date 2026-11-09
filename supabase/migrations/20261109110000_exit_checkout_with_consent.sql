-- 2026-11-09 (owner: "automatic clock-out after a warning notification and the user's approval";
-- spec B-09: nobody is clocked out without confirming). The site policy AUTO no longer clocks a
-- person out by itself:
--   * leaving the site still sends "You left the site - clock out?" at once (as before);
--   * with no answer, after the site's minutes outside one reminder follows - never a clock-out;
--   * when the person agrees (confirm_prosm_time_site_exit), the shift is clocked out at the time
--     they LEFT the site, not the time they tapped - the accuracy AUTO was for, with consent;
--   * "Still working" stops the reminder as before. PROMPT keeps the normal clock-out (now).
-- Nothing is deleted: AUTO stays a site option, its meaning is now "clock out at the time I left,
-- once I agree".

begin;

alter table public.presence_sessions add column if not exists exit_reminded_at timestamptz;

-- One reminder after the site's minutes outside, never a clock-out.
create or replace function public.prosm_time_remind_site_exit(p_presence_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_presence presence_sessions%rowtype;
    v_site sites%rowtype;
begin
    update presence_sessions set exit_reminded_at = now()
    where id = p_presence_session_id and status = 'active' and exit_reminded_at is null and exit_dismissed_at is null and exit_since is not null
    returning * into v_presence;
    if v_presence.id is null then return false; end if;
    select * into v_site from sites where id = v_presence.site_id;
    perform public.create_prosm_time_notification(
        v_presence.organization_id, v_presence.user_id, 'exit_site_prompt', 'high', 'You are still outside the site',
        'Your shift is still open. Clock out at the time you left?', 'attendance_sessions', v_presence.attendance_session_id,
        jsonb_build_object('siteName', v_site.name, 'policy', v_site.exit_policy, 'reminder', true, 'leftAt', v_presence.exit_since)
    );
    return true;
end;
$function$;
revoke all on function public.prosm_time_remind_site_exit(uuid) from public, anon, authenticated;

-- The sample rule: the AUTO branch reminds instead of clocking out
do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_track_site_exit(uuid, jsonb, double precision)'::regprocedure);
    v_old text := '        return jsonb_build_object(''autoCheckout'', public.prosm_time_auto_checkout_on_exit(p_presence_session_id));';
begin
    if position(v_old in v_def) = 0 then raise exception 'site exit: auto branch not found'; end if;
    execute replace(v_def, v_old, '        return jsonb_build_object(''reminded'', public.prosm_time_remind_site_exit(p_presence_session_id));');
end $$;

-- The 5-minute job: reminders only
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
          and p.exit_prompted_at is not null and p.exit_dismissed_at is null and p.exit_reminded_at is null and p.exit_since is not null
          and now() - p.exit_since >= make_interval(mins => s.exit_auto_minutes)
    loop
        if public.prosm_time_remind_site_exit(v_id) then v_count := v_count + 1; end if;
    end loop;
    return v_count;
end;
$function$;

-- The person agrees: clocked out at the time they left the site (AUTO sites)
create or replace function public.confirm_prosm_time_site_exit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_presence presence_sessions%rowtype;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_out timestamptz;
    v_name text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_presence from presence_sessions
    where user_id = v_caller and status = 'active' and exit_since is not null and exit_prompted_at is not null
    order by started_at desc limit 1 for update;
    if v_presence.id is null then raise exception 'NO OPEN QUESTION ABOUT LEAVING THE SITE'; end if;
    select * into v_site from sites where id = v_presence.site_id;
    if v_site.exit_policy <> 'AUTO' then raise exception 'THIS SITE CLOCKS OUT WITH THE NORMAL CLOCK-OUT'; end if;
    select * into v_session from attendance_sessions where id = v_presence.attendance_session_id for update;
    if v_session.id is null or v_session.status <> 'clocked_in' then raise exception 'YOU ARE NOT CURRENTLY CLOCKED IN'; end if;

    v_out := greatest(v_presence.exit_since, v_session.clock_in_at + interval '1 minute');
    update attendance_sessions set status = 'clocked_out', clock_out_at = v_out, auto_checkout_geofence = true, updated_at = now() where id = v_session.id;
    insert into attendance_events (session_id, user_id, event_type, occurred_at, idempotency_key, geofence_checked, within_geofence, note, time_source)
    values (v_session.id, v_session.user_id, 'clock_out', v_out, 'exit-confirmed:' || v_session.id, true, false, 'exit_confirmed', 'auto_geofence')
    on conflict do nothing;
    update presence_sessions set status = 'ended', ended_at = v_presence.exit_since, end_reason = 'clock_out' where id = v_presence.id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_session.organization_id, v_caller, v_caller, 'attendance.exit_confirmed', 'attendance_sessions', v_session.id,
            'Clocked out at the time of leaving the site, confirmed by the employee',
            jsonb_build_object('status', 'clocked_in'), jsonb_build_object('status', 'clocked_out', 'clockOutAt', v_out));
    select full_name into v_name from users where id = v_caller;
    perform public.notify_prosm_time_site_managers_or_owner(
        v_session.organization_id, v_session.site_id, 'auto_checkout_geofence', 'normal', 'Clocked out on leaving the site',
        v_name || ' confirmed the clock-out at the time they left the site.', 'attendance_sessions', v_session.id,
        jsonb_build_object('kind', 'manager', 'employeeName', v_name, 'clockOutAt', v_out, 'confirmed', true)
    );
    return jsonb_build_object('success', true, 'clockOutAt', v_out);
end;
$function$;
revoke all on function public.confirm_prosm_time_site_exit() from public, anon;
grant execute on function public.confirm_prosm_time_site_exit() to authenticated;

-- What the prompt needs to show: the site's policy and the time the person left
create or replace function public.get_prosm_time_exit_prompt()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object('policy', s.exit_policy, 'leftAt', p.exit_since, 'siteName', s.name, 'reminded', p.exit_reminded_at is not null)
    from presence_sessions p join sites s on s.id = p.site_id
    where p.user_id = public.current_prosm_time_user_id() and p.status = 'active'
      and p.exit_prompted_at is not null and p.exit_dismissed_at is null
    order by p.started_at desc limit 1;
$$;
revoke all on function public.get_prosm_time_exit_prompt() from public, anon;
grant execute on function public.get_prosm_time_exit_prompt() to authenticated;

commit;
