-- PROSM Time - real bug found live-testing (user report: "starting a
-- break gives 'unable to start break'"). Root cause confirmed via a
-- rolled-back transaction against the user's own real open session
-- (a manual/no-site clock-in, WP-06's own "optional site clock-in"
-- feature - manual_location_label set, site_id null): both
-- start_prosm_time_break and end_prosm_time_break do
-- `select * into v_site from sites where id = v_session.site_id`
-- (or the attendance_sessions-joined equivalent) - when site_id is
-- null this matches no row, leaving v_site entirely null, and:
--   - start_prosm_time_break inserts v_site.break_paid_by_default
--     (null) into break_events.paid, a NOT NULL column -> crash.
--   - end_prosm_time_break computes v_exceeded against
--     v_site.break_max_duration_minutes (null), giving a null
--     max_duration_exceeded - also a NOT NULL column -> would crash
--     the same way the moment anyone tried to end a break on a
--     no-site session.
-- Both never accounted for WP-06's later no-site clock-in feature.
-- Fix: coalesce to sensible defaults when there is no site to check
-- against (paid=true, no max-duration check possible so never
-- "exceeded") - same "nothing to check" posture
-- compute_prosm_time_geofence_check already uses for a null site.

begin;

create or replace function public.start_prosm_time_break(
    p_attendance_session_id uuid,
    p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_break_id uuid;
    v_existing break_events%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is not null then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO START A BREAK'; end if;

    if exists (select 1 from break_events where attendance_session_id = p_attendance_session_id and status = 'active') then
        raise exception 'A BREAK IS ALREADY ACTIVE FOR THIS SESSION';
    end if;

    if v_session.site_id is not null then
        select * into v_site from sites where id = v_session.site_id;
    end if;

    insert into break_events (organization_id, attendance_session_id, user_id, paid, idempotency_key)
    values (v_session.organization_id, p_attendance_session_id, v_caller_id, coalesce(v_site.break_paid_by_default, true), p_idempotency_key)
    returning id into v_break_id;

    return jsonb_build_object('success', true, 'breakId', v_break_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
    when others then
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.end_prosm_time_break(p_break_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    -- No site (or no site policy) to check the max duration against -
    -- never flagged as exceeded, same as it simply never being
    -- configured on a real site.
    v_exceeded := coalesce(extract(epoch from (now() - v_break.started_at)) / 60 > v_site.break_max_duration_minutes, false);

    update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;

    if v_exceeded then
        perform public.create_prosm_time_notification(
            v_break.organization_id, v_caller_id, 'break_exceeded', 'normal', 'Break duration exceeded',
            'Your break exceeded the maximum allowed duration.', 'break_events', p_break_id
        );
    end if;

    return jsonb_build_object('success', true, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'END PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

commit;
