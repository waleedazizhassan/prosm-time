-- 2026-11-10 (owner): "I made an employee a manager and put him on a site: his page changed, but the
-- KPI cards are all zero while the people below show three present". The people list shows whoever
-- is assigned to the manager's sites OR is working at one of them right now (also when they clocked in
-- without a site and the nearest site is responsible); the dashboard counted only those ASSIGNED.
-- The dashboard's team now follows the same rule, and also counts whoever worked at those sites in the
-- chosen period, so the figures match the people shown.
-- Rollback: restore get_prosm_time_manager_dashboard's team clause (assignment only) from
-- 20261028100000 (later patches in 20261108160000, 20261109100000, 20261109270000, 20261109290000 keep).

begin;

do $patch$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date,date,text,uuid,text)'::regprocedure);
    v_anchor text := 'or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(v_sites))';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'dashboard team anchor not found'; end if;
    v_def := replace(v_def, v_anchor, v_anchor || '
              or exists (select 1 from attendance_sessions ts
                         where ts.user_id = u.id
                           and coalesce(ts.site_id, ts.responsible_site_id) = any(v_sites)
                           and (ts.status = ''clocked_in'' or ts.clock_in_at::date between p_from and p_to))');
    execute v_def;
end;
$patch$;

commit;
