-- Fix: start_prosm_time_break relied on a raw unique_violation from
-- break_events_one_active_per_session to reject a second concurrent
-- break, surfacing Postgres's own constraint-name error text instead
-- of a clean message. Adds the same explicit pre-check pattern used
-- everywhere else in this codebase for "already in that state" cases.
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

    select * into v_site from sites where id = v_session.site_id;

    insert into break_events (organization_id, attendance_session_id, user_id, paid, idempotency_key)
    values (v_session.organization_id, p_attendance_session_id, v_caller_id, v_site.break_paid_by_default, p_idempotency_key)
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
