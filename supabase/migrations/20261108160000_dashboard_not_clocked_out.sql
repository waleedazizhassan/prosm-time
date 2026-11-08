-- 2026-11-08 B-06 ("did not clock out" must be reliable): the card listed only people still
-- clocked in an hour after a known end - their shift's end, or the site's working-day end. A
-- session left open from an earlier day at a site with no end time and no shift never showed,
-- however old. Such a session now counts too: it ends at the close of its own work day (midnight
-- in the site's time zone), so it shows from 01:00 the next day. Nothing else in the dashboard
-- changes.

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date, date, text, uuid, text)'::regprocedure);
    v_old_end text := '                           case when ((w.work_date + w.end_time) at time zone w.tz) <= o.clock_in_at';
    v_new_end text := '                           case when w.end_time is null then ((w.work_date + 1)::timestamp at time zone w.tz)
                                when ((w.work_date + w.end_time) at time zone w.tz) <= o.clock_in_at';
    v_old_where text := '                    where w.end_time is not null';
    v_new_where text := '                    where w.end_time is not null or w.work_date < public.prosm_time_work_date(now(), o.site_id, o.organization_id)';
begin
    if position(v_old_end in v_def) = 0 or position(v_old_where in v_def) = 0 then
        raise exception 'dashboard not-clocked-out: anchor not found';
    end if;
    v_def := replace(v_def, v_old_end, v_new_end);
    v_def := replace(v_def, v_old_where, v_new_where);
    execute v_def;
end $$;

commit;
