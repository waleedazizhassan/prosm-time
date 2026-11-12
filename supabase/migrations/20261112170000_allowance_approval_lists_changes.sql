-- Owner 2026-11-12: "when the manager reviews an employee's allowances, Edit lets him change any amount of any
-- line; when he approves, the employee is told in a notification what was changed". The edits during review
-- were already possible (20261025140000) and audited; the approval notification now carries them: each line
-- changed (day, line, before, after, reason), and its text says how many lines the manager changed.
-- Rollback: restore review_prosm_time_allowance_sheet from 20261101160000_allowance_reject_reason.sql.

begin;

do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.review_prosm_time_allowance_sheet(uuid,text,text)'::regprocedure), chr(13) || chr(10), chr(10));
    a text := 'jsonb_build_object(''days'', v_sheet.days, ''periodStart'', v_sheet.period_start, ''periodEnd'', v_sheet.period_end)';
begin
    if position(a in v_def) = 0 then raise exception 'allowance approval anchor not found'; end if;
    v_def := replace(v_def, a, a || '
            || case when p_action = ''approved'' then coalesce((
                   select jsonb_build_object(''changes'', jsonb_agg(jsonb_build_object(
                              ''date'', e.entry_date, ''line'', x.field, ''before'', x.previous_value, ''after'', x.new_value, ''reason'', x.reason)
                              order by e.entry_date, x.created_at))
                   from allowance_entry_adjustments x join allowance_entries e on e.id = x.entry_id
                   where x.sheet_id = p_sheet_id
                   having count(*) > 0), ''{}''::jsonb) else ''{}''::jsonb end');
    execute v_def;
end;
$patch$;

commit;
