-- Owner 2026-10-21 ("an employee should be able to produce their own
-- timesheet"): anyone may generate a timesheet for themselves; for others it
-- still takes timesheets.generate and authority over them. The rest of the
-- function is unchanged (patched in place).

begin;

do $$
declare
    v_def text;
    v_anchor constant text := 'public.current_prosm_time_user_is_owner()';
begin
    v_def := pg_get_functiondef('public.generate_prosm_time_timesheet(uuid, date, date)'::regprocedure);
    if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
        raise exception 'generate_prosm_time_timesheet changed - authority check not found once';
    end if;
    execute replace(v_def, v_anchor, v_anchor || ' or p_user_id = v_caller_id');
end;
$$;

commit;
