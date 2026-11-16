-- QA-012 (2026-11-16): the same clock-in sent twice at once (a retry on a weak network) - the second answered "you are
-- already clocked in" instead of the first one's result, because the key was checked before any lock. The person's
-- clock-in now takes a per-person transaction lock first: the second waits, then finds the first's event and answers
-- with it (replay). The data was always right (one session); this makes the answer right too.
-- Rollback: re-run clock_in_prosm_time_attendance without the lock line.
begin;
do $$
declare
    v_def text;
    v_sig regprocedure := 'public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision, text, text, text, boolean, boolean)'::regprocedure;
    v_old text := $q$    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;$q$;
    v_new text := $q$    -- QA-012: one clock-in per person at a time - a second copy waits here and then answers with the first's result
    perform pg_advisory_xact_lock(hashtextextended('prosm_time_clock_in:' || v_caller_id::text, 0));
    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;$q$;
begin
    v_def := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    if position('prosm_time_clock_in:' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'clock in: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;
commit;
