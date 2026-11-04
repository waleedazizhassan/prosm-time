-- 2026-11-03 (owner, with "PROSM-Time-Plans-Full.pdf"): the three plans carry what the
-- app really has, and a plan's features are enforced on the server, not only shown.
--   Starter  : clocking with GPS, geofence, photo, offline, map, basic reports; up to 3 sites;
--              owner and employees only.
--   Business : + unlimited sites, clocking on behalf, kiosk and external workers, leave,
--              allowances and their approvals, report export, payroll export, clock rules
--              (early-leave grace, rounding), shift scheduling (open shifts, swaps);
--              manager and supervisor roles.
--   Pro      : + audit log, SOS, viewer role and personal permissions, longer history,
--              the clock-in question on arrival, labour cost and project budgets,
--              integrations (API keys), daily summary, manager alerts.
-- 'legacy' (organisations from before plans) and every trial keep everything.
-- A refused action raises 'FEATURE NOT IN PLAN: <feature>'. Server jobs (no signed-in
-- caller) are not refused by the table guards.
-- Rollback: drop the guard triggers and functions created here, run the DO block at the
-- end in reverse (remove the "perform public.prosm_time_require_feature" lines), and
-- restore plans.feature_flags/history_days from 20261101120000.

begin;

update public.plans set history_days = 730, feature_flags = '{}'::jsonb where key = 'starter';
update public.plans set history_days = 730, feature_flags = '{"leave": true, "allowances": true, "approvals": true, "kiosk": true, "on_behalf": true, "export": true, "payroll_export": true, "clock_rules": true, "scheduling": true, "roles_manager": true}'::jsonb where key = 'business';
update public.plans set history_days = 1825, feature_flags = '{"leave": true, "allowances": true, "approvals": true, "kiosk": true, "on_behalf": true, "export": true, "payroll_export": true, "clock_rules": true, "scheduling": true, "roles_manager": true, "audit": true, "sos": true, "roles_all": true, "clock_suggestion": true, "labor_cost": true, "integrations": true, "daily_summary": true, "manager_alerts": true}'::jsonb where key = 'pro';
update public.plans set feature_flags = (select feature_flags from public.plans where key = 'pro') where key = 'legacy';

-- Does this organisation's plan include the feature? No entitlement row = yes (nothing taken away).
create or replace function public.prosm_time_plan_allows(p_org uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select case when e.plan = 'legacy' or e.status = 'trial' then true
                    else coalesce((p.feature_flags ->> p_feature)::boolean, false) end
        from entitlements e join plans p on p.key = e.plan
        where e.organization_id = p_org), true);
$$;
revoke all on function public.prosm_time_plan_allows(uuid, text) from public, anon, authenticated;

create or replace function public.prosm_time_require_feature(p_feature text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_org is not null and not public.prosm_time_plan_allows(v_org, p_feature) then
        raise exception 'FEATURE NOT IN PLAN: %', p_feature;
    end if;
end;
$$;
revoke all on function public.prosm_time_require_feature(text) from public, anon, authenticated;

-- What the signed-in person's organisation can use, for the app to show or hide screens.
create or replace function public.get_prosm_time_plan_features()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select jsonb_build_object(
            'plan', e.plan,
            'status', e.status,
            'features', case when e.plan = 'legacy' or e.status = 'trial'
                             then (select feature_flags from plans where key = 'pro')
                             else p.feature_flags end)
        from entitlements e join plans p on p.key = e.plan
        where e.organization_id = public.current_prosm_time_organization_id()),
        jsonb_build_object('plan', 'legacy', 'status', 'active', 'features', (select feature_flags from plans where key = 'pro')));
$$;
revoke all on function public.get_prosm_time_plan_features() from public, anon;
grant execute on function public.get_prosm_time_plan_features() to authenticated;

-- Table guard: a signed-in caller cannot create a record of a feature outside the plan.
create or replace function public.prosm_time_refuse_outside_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null and not public.prosm_time_plan_allows(new.organization_id, tg_argv[0]) then
        raise exception 'FEATURE NOT IN PLAN: %', tg_argv[0];
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_refuse_outside_plan() from public, anon, authenticated;

do $$
declare
    v_pair text[];
begin
    foreach v_pair slice 1 in array array[
        ['leave_requests', 'leave'],
        ['allowance_entries', 'allowances'],
        ['allowance_sheets', 'allowances'],
        ['site_workers', 'kiosk'],
        ['site_worker_attendance', 'kiosk'],
        ['admin_on_behalf_actions', 'on_behalf'],
        ['report_exports', 'export'],
        ['shift_assignments', 'scheduling'],
        ['shift_templates', 'scheduling'],
        ['open_shifts', 'scheduling'],
        ['shift_swap_requests', 'scheduling'],
        ['sos_alerts', 'sos'],
        ['api_keys', 'integrations']
    ] loop
        execute format('drop trigger if exists %I on public.%I', v_pair[1] || '_plan_guard', v_pair[1]);
        execute format('create trigger %I before insert on public.%I for each row execute function public.prosm_time_refuse_outside_plan(%L)',
                       v_pair[1] || '_plan_guard', v_pair[1], v_pair[2]);
    end loop;
end $$;

-- Clock rules: the early-leave grace and rounding are Business and up.
create or replace function public.prosm_time_guard_clock_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null
       and (new.min_early_leave_minutes is not null or new.round_minutes is not null)
       and (tg_op = 'INSERT' or new.min_early_leave_minutes is distinct from old.min_early_leave_minutes or new.round_minutes is distinct from old.round_minutes)
       and not public.prosm_time_plan_allows(new.organization_id, 'clock_rules') then
        raise exception 'FEATURE NOT IN PLAN: clock_rules';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_guard_clock_rules() from public, anon, authenticated;
drop trigger if exists overtime_policies_clock_rules_plan_guard on public.overtime_policies;
create trigger overtime_policies_clock_rules_plan_guard
before insert or update on public.overtime_policies
for each row execute function public.prosm_time_guard_clock_rules();

-- Roles: manager and supervisor are Business and up; the viewer (read_only) is Pro.
create or replace function public.prosm_time_guard_role_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key text;
begin
    if auth.uid() is null or new.is_owner or new.role_id is null then return new; end if;
    if tg_op = 'UPDATE' and new.role_id is not distinct from old.role_id then return new; end if;
    select role_key into v_key from roles where id = new.role_id;
    if v_key in ('manager', 'supervisor') and not public.prosm_time_plan_allows(new.organization_id, 'roles_manager') then
        raise exception 'FEATURE NOT IN PLAN: roles_manager';
    end if;
    if v_key = 'read_only' and not public.prosm_time_plan_allows(new.organization_id, 'roles_all') then
        raise exception 'FEATURE NOT IN PLAN: roles_all';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_guard_role_plan() from public, anon, authenticated;
drop trigger if exists users_role_plan_guard on public.users;
create trigger users_role_plan_guard
before insert or update of role_id on public.users
for each row execute function public.prosm_time_guard_role_plan();

-- Functions that read or set a plan feature: the plan check runs first.
do $$
declare
    v_pair text[];
    v_def text;
    v_new text;
begin
    foreach v_pair slice 1 in array array[
        ['list_prosm_time_audit_log', 'audit'],
        ['list_prosm_time_report_labor_cost', 'labor_cost'],
        ['get_prosm_time_schedule_cost', 'labor_cost'],
        ['list_prosm_time_project_budgets', 'labor_cost'],
        ['set_prosm_time_project_budget', 'labor_cost'],
        ['list_prosm_time_report_payroll', 'payroll_export'],
        ['save_prosm_time_payroll_template', 'payroll_export'],
        ['set_prosm_time_clock_suggestion', 'clock_suggestion'],
        ['get_prosm_time_daily_summary', 'daily_summary'],
        ['set_prosm_time_user_permission_override', 'roles_all'],
        ['admin_clock_in_prosm_time_attendance', 'on_behalf'],
        ['admin_clock_out_prosm_time_attendance', 'on_behalf'],
        ['generate_prosm_time_api_key', 'integrations']
    ] loop
        for v_def in
            select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v_pair[1]
        loop
            continue when position('prosm_time_require_feature' in v_def) > 0;
            v_new := regexp_replace(v_def, E'(\\n[ \\t]*begin\\M[^\\n]*\\n)', '\1    perform public.prosm_time_require_feature(''' || v_pair[2] || ''');' || chr(10), 'i');
            if v_new = v_def then raise exception 'NO BEGIN FOUND IN %', v_pair[1]; end if;
            execute v_new;
        end loop;
    end loop;
end $$;

-- Manager alerts (missed shift, overtime soon, morning summary) only where the plan has them.
do $$
declare
    v_def text := pg_get_functiondef('public.process_prosm_time_manager_alerts()'::regprocedure);
    v_new text;
begin
    if position('manager_alerts' in v_def) = 0 then
        v_new := regexp_replace(v_def, 'not public\.prosm_time_org_locked\(([a-z_.]+)\)',
                                'not public.prosm_time_org_locked(\1) and public.prosm_time_plan_allows(\1, ''manager_alerts'')', 'g');
        if v_new = v_def then raise exception 'MANAGER ALERTS: NO ORGANISATION FILTER FOUND'; end if;
        execute v_new;
    end if;
end $$;

commit;
