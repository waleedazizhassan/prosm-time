-- Owner 2026-11-13: the "Late today: 1" card opened a window "for the period chosen above" with the period's
-- late days and minutes - and its "today" column empty, although the card counted someone late today. The
-- window now lists today's late people only (the same rule as the card's count), each with how late and when
-- they arrived; the period's lateness gets its own card further down the dashboard (from byPerson, unchanged).
-- Adds 'lateTodayList' to get_prosm_time_manager_dashboard. Rollback: re-run the function from before this
-- migration (pg_get_functiondef).

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date, date, text, uuid, text)'::regprocedure);
    v_old text := '''overdue'', coalesce((';
    v_new text := '''lateTodayList'', coalesce((
            select jsonb_agg(jsonb_build_object(
                       ''userId'', u.id, ''name'', u.full_name, ''avatarUrl'', u.avatar_url,
                       ''siteName'', (select st.name from sites st where st.id = (ts.s ->> ''siteId'')::uuid),
                       ''lateMinutes'', round(coalesce((ts.s ->> ''lateMinutes'')::numeric, 0)),
                       ''firstIn'', ts.s ->> ''firstIn'')
                   order by coalesce((ts.s ->> ''lateMinutes'')::numeric, 0) desc, u.full_name)
            from late_today lt
            join users u on u.id = lt.user_id
            left join today_summaries ts on ts.user_id = lt.user_id
        ), ''[]''::jsonb),

        ''overdue'', coalesce((';
begin
    if position(v_old in v_def) = 0 then raise exception 'manager dashboard: overdue anchor not found'; end if;
    if position('lateTodayList' in v_def) > 0 then raise exception 'manager dashboard: lateTodayList already there'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

commit;
