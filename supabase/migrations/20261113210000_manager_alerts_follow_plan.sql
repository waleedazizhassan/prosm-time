-- Owner 2026-11-13 ("review the governance, the permissions and the plans' limits"): the review found one plan
-- feature the server did not hold back - the manager alerts (no-show and overtime) are a Pro feature, yet the
-- job sent them to every organisation. They now follow the plan, as every other feature does.
-- Rollback: re-run process_prosm_time_manager_alerts from before this migration (pg_get_functiondef).

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.process_prosm_time_manager_alerts()'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def, 'and not public.prosm_time_org_locked(sa.organization_id)',
        'and not public.prosm_time_org_locked(sa.organization_id) and public.prosm_time_plan_allows(sa.organization_id, ''manager_alerts'')');
    v_new := replace(v_new, 'and not public.prosm_time_org_locked(a.organization_id)',
        'and not public.prosm_time_org_locked(a.organization_id) and public.prosm_time_plan_allows(a.organization_id, ''manager_alerts'')');
    if v_new = v_def or position('manager_alerts''' in v_new) = 0 then raise exception 'manager alerts: anchors not found'; end if;
    execute v_new;
end $$;

commit;
