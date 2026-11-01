-- 2026-11-01 (plan stage 4.7; Privacy Policy v2 section 3): a break's start and
-- end carry the location, and with require_gps they need a valid one, online or
-- offline. Old apps that send none keep working where require_gps is off.
-- Rollback: restore both four-argument functions and drop the six columns.

begin;

alter table public.break_events
    add column start_latitude double precision,
    add column start_longitude double precision,
    add column start_accuracy_meters double precision,
    add column end_latitude double precision,
    add column end_longitude double precision,
    add column end_accuracy_meters double precision;

drop function public.start_prosm_time_break(uuid, text, timestamp with time zone, boolean);
drop function public.end_prosm_time_break(uuid, text, timestamp with time zone, boolean);

CREATE OR REPLACE FUNCTION public.start_prosm_time_break(p_attendance_session_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_break_id uuid;
    v_existing break_events%rowtype;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    -- require_gps: no valid reading, no record (offline replay included)
    perform public.prosm_time_require_location(public.current_prosm_time_organization_id(), p_latitude, p_longitude, p_accuracy_meters);

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

    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_session.clock_in_at, v_session.site_id);
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    if v_session.site_id is not null then
        select * into v_site from sites where id = v_session.site_id;
    end if;

    insert into break_events (start_latitude, start_longitude, start_accuracy_meters, organization_id, attendance_session_id, user_id, paid, idempotency_key, started_at, start_time_source)
    values (p_latitude, p_longitude, p_accuracy_meters, v_session.organization_id, p_attendance_session_id, v_caller_id, coalesce(v_site.break_paid_by_default, true), p_idempotency_key, v_effective_time, v_time_source)
    returning id into v_break_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_session.organization_id, v_caller_id, v_session.site_id, 'break_start', 'break_events', v_break_id, v_effective_time);
    end if;

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

CREATE OR REPLACE FUNCTION public.end_prosm_time_break(p_break_id uuid, p_idempotency_key text DEFAULT NULL::text, p_client_reported_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_offline_replay boolean DEFAULT false, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_meters double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
    v_effective_time timestamptz;
    v_time jsonb;
    v_time_source text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    -- require_gps: no valid reading, no record (offline replay included)
    perform public.prosm_time_require_location(public.current_prosm_time_organization_id(), p_latitude, p_longitude, p_accuracy_meters);

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    -- A resend of an end that already reached the server (offline sync): the same answer, never a second end.
    if p_idempotency_key is not null and v_break.end_idempotency_key = p_idempotency_key then
        return jsonb_build_object('success', true, 'maxDurationExceeded', v_break.max_duration_exceeded, 'replay', true);
    end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    -- Live: server time. Offline replay: the device time, flagged for review (audit 1.4).
    v_time := public.resolve_prosm_time_reported_time(v_caller_id, p_client_reported_at, p_offline_replay, v_break.started_at, (select site_id from attendance_sessions where id = v_break.attendance_session_id));
    v_effective_time := (v_time->>'time')::timestamptz;
    v_time_source := v_time->>'source';

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    -- No site (or no site policy) to check the max duration against -
    -- never flagged as exceeded, same as it simply never being
    -- configured on a real site.
    v_exceeded := coalesce(extract(epoch from (v_effective_time - v_break.started_at)) / 60 > v_site.break_max_duration_minutes, false);

    update break_events set end_latitude = p_latitude, end_longitude = p_longitude, end_accuracy_meters = p_accuracy_meters, status = 'ended', ended_at = v_effective_time, max_duration_exceeded = v_exceeded, end_idempotency_key = p_idempotency_key, end_time_source = v_time_source where id = p_break_id;

    if v_time_source = 'device_offline' then
        perform public.record_prosm_time_offline_time_review(v_break.organization_id, v_caller_id, v_site.id, 'break_end', 'break_events', p_break_id, v_effective_time);
    end if;

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

revoke all on function public.start_prosm_time_break(uuid, text, timestamp with time zone, boolean, double precision, double precision, double precision) from public, anon;
revoke all on function public.end_prosm_time_break(uuid, text, timestamp with time zone, boolean, double precision, double precision, double precision) from public, anon;
grant execute on function public.start_prosm_time_break(uuid, text, timestamp with time zone, boolean, double precision, double precision, double precision) to authenticated;
grant execute on function public.end_prosm_time_break(uuid, text, timestamp with time zone, boolean, double precision, double precision, double precision) to authenticated;

commit;
