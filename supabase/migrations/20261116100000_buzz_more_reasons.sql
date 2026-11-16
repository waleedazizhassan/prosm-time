-- Buzz (owner 2026-11-16: "more buzz messages - go home early, you're off tomorrow, don't be late for your shift
-- and so on"): eight more ready reasons beside clock in / clock out / call me / check the app. Same rules (who may
-- buzz whom, 30 seconds apart, 140 characters); only the list of reasons and their English fallback text grow.
-- An older app shows a new reason as "Please check the app." (it falls back to 'attention').
-- Rollback: re-run send_prosm_time_buzz from 20261110170000.

begin;

do $$
declare
    v_def text;
    v_list_old text := $q$if v_reason not in ('clock_in', 'clock_out', 'call_me', 'attention') then$q$;
    v_list_new text := $q$if v_reason not in ('clock_in', 'clock_out', 'call_me', 'attention', 'go_home_early', 'tomorrow_off', 'dont_be_late', 'end_break', 'come_to_office', 'check_messages', 'shift_changed', 'well_done') then$q$;
    v_text_old text := $q$when 'call_me' then 'Please call me.' else 'Please check the app.' end$q$;
    v_text_new text := $q$when 'call_me' then 'Please call me.' when 'go_home_early' then 'You can go home early today.' when 'tomorrow_off' then 'You are off tomorrow.' when 'dont_be_late' then 'Please do not be late for your shift.' when 'end_break' then 'Please end your break.' when 'come_to_office' then 'Please come to the office.' when 'check_messages' then 'Please check your messages.' when 'shift_changed' then 'Your shift has changed - check your schedule.' when 'well_done' then 'Well done - thank you.' else 'Please check the app.' end$q$;
begin
    v_def := replace(pg_get_functiondef('public.send_prosm_time_buzz(uuid, text, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('go_home_early' in v_def) > 0 then return; end if;
    if position(v_list_old in v_def) = 0 or position(v_text_old in v_def) = 0 then raise exception 'buzz: anchor not found'; end if;
    execute replace(replace(v_def, v_list_old, v_list_new), v_text_old, v_text_new);
end $$;

commit;
