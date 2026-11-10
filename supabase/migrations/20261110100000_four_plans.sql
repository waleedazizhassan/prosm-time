-- 2026-11-10 (owner, "PROSM_Time_Plans_Pricing.pdf"): four plans, managed from PROSM Platform Manager
-- (Platform migration 20261110100000) and enforced here.
--   Starter    : clocking (GPS, geofence, photo, offline), live map, SOS, radio, weather; up to 3 sites;
--                owner + ONE manager + employees; 1 year of records. No kiosk or external labour.
--   Business   : + media centre (announcements, departments), leave and permissions, scheduling,
--                timesheets, allowances, kiosk and external labour, on behalf, clock rules, full
--                dashboard and reports, export; all managers and supervisors; 2 years.
--   Pro        : + payroll, external pay and labour cost, audit log, detailed permissions, clock-in
--                question, daily summary, manager alerts; 5 years.
--   Enterprise : + API and imported attendance, full and time-limited delegation, data retention
--                control; all records.
-- SOS is in every plan. The API is Enterprise only (it was opened to every plan on 2026-11-09).
-- A trial is Enterprise in full; organisations from before plans ("legacy") keep everything.
-- External workers: Platform Manager sets the real number a licence allows; it arrives with the
-- licence status (max_external_workers) and more active workers are refused. Every 10 workers are
-- billed as one user (shown on the plan screen).
-- Rollback: restore plans.feature_flags/history_days from 20261103140000 + 20261108130000 (payroll)
-- + 20261109210000 (integrations); delete plan 'enterprise' and its platform_plan_map row; restore
-- get_prosm_time_plan_features, prosm_time_entitlement_for_new_license, prosm_time_api_enabled,
-- prosm_time_guard_role_plan, prosm_time_check_role_plan, get_prosm_time_plan_status and the
-- 6-argument refresh_prosm_time_license_state from their earlier migrations; drop the
-- announcements/departments plan guards, the site_workers limit trigger and the
-- max_external_workers column; remove the delegation/retention require_feature lines.

begin;

-- 1. The four plans.
insert into public.plans (key, name, max_employees, max_sites, history_days, feature_flags)
values ('enterprise', 'Enterprise', null, null, null, '{}'::jsonb)
on conflict (key) do nothing;

update public.plans set name = 'Starter', max_sites = 3, history_days = 365,
    feature_flags = '{"sos": true}'::jsonb
where key = 'starter';
update public.plans set name = 'Business', max_sites = null, history_days = 730,
    feature_flags = '{"sos": true, "announcements": true, "departments": true, "leave": true, "approvals": true, "scheduling": true, "allowances": true, "kiosk": true, "on_behalf": true, "clock_rules": true, "export": true, "payroll_export": true, "roles_manager": true}'::jsonb
where key = 'business';
update public.plans set name = 'Pro', max_sites = null, history_days = 1825,
    feature_flags = '{"sos": true, "announcements": true, "departments": true, "leave": true, "approvals": true, "scheduling": true, "allowances": true, "kiosk": true, "on_behalf": true, "clock_rules": true, "export": true, "payroll_export": true, "roles_manager": true, "payroll": true, "labor_cost": true, "audit": true, "roles_all": true, "clock_suggestion": true, "daily_summary": true, "manager_alerts": true}'::jsonb
where key = 'pro';
update public.plans set name = 'Enterprise', max_sites = null, history_days = null,
    feature_flags = (select feature_flags from public.plans where key = 'pro') || '{"integrations": true, "delegation": true, "retention": true}'::jsonb
where key = 'enterprise';
update public.plans set feature_flags = (select feature_flags from public.plans where key = 'enterprise'), history_days = null
where key = 'legacy';

-- 2. Platform Manager's Enterprise plan maps to it; the stored keys follow the plan names.
insert into public.platform_plan_map (platform_plan_id, plan, platform_plan_key)
values ('e4b7f1a2-6c3d-4f5e-9a8b-7c6d5e4f3a21', 'enterprise', 'enterprise')
on conflict (platform_plan_id) do update set plan = excluded.plan, platform_plan_key = excluded.platform_plan_key;
update public.platform_plan_map set platform_plan_key = plan where platform_plan_key <> plan;

-- 3. A trial (and anything without a plan) is Enterprise in full.
do $patch$
declare
    v_def text;
begin
    v_def := pg_get_functiondef('public.get_prosm_time_plan_features()'::regprocedure);
    if position('where key = ''pro''' in v_def) = 0 then raise exception 'plan features anchor not found'; end if;
    execute replace(v_def, 'where key = ''pro''', 'where key = ''enterprise''');

    v_def := pg_get_functiondef('public.prosm_time_entitlement_for_new_license()'::regprocedure);
    if position('then ''pro''' in v_def) = 0 then raise exception 'entitlement trigger anchor not found'; end if;
    execute replace(v_def, 'then ''pro''', 'then ''enterprise''');
end;
$patch$;
update public.entitlements set plan = 'enterprise', updated_at = now() where status = 'trial' and plan = 'pro';

-- 4. The API follows the plan (legacy and trials included), not only the plan row.
create or replace function public.prosm_time_api_enabled(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_plan_allows(p_org, 'integrations');
$$;
revoke all on function public.prosm_time_api_enabled(uuid) from public, anon, authenticated;

-- 5. New gates: the media centre (Business and up); delegation and retention control (Enterprise).
drop trigger if exists announcements_plan_guard on public.announcements;
create trigger announcements_plan_guard before insert on public.announcements
for each row execute function public.prosm_time_refuse_outside_plan('announcements');
drop trigger if exists departments_plan_guard on public.departments;
create trigger departments_plan_guard before insert on public.departments
for each row execute function public.prosm_time_refuse_outside_plan('departments');

do $patch$
declare
    v_pair text[];
    v_def text;
    v_new text;
begin
    foreach v_pair slice 1 in array array[
        ['grant_prosm_time_owner_authority', 'delegation'],
        ['set_prosm_time_retention', 'retention']
    ] loop
        for v_def in
            select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v_pair[1]
        loop
            continue when position('prosm_time_require_feature(''' || v_pair[2] || ''')' in v_def) > 0;
            v_new := regexp_replace(v_def, E'(\\n[ \\t]*begin\\M[^\\n]*\\n)', '\1    perform public.prosm_time_require_feature(''' || v_pair[2] || ''');' || chr(10), 'i');
            if v_new = v_def then raise exception 'NO BEGIN FOUND IN %', v_pair[1]; end if;
            execute v_new;
        end loop;
    end loop;
end;
$patch$;

-- 6. Roles: Starter has one manager (no supervisors); Business and up all of them; the viewer is Pro.
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
    if v_key = 'supervisor' and not public.prosm_time_plan_allows(new.organization_id, 'roles_manager') then
        raise exception 'FEATURE NOT IN PLAN: roles_manager';
    end if;
    if v_key = 'manager' and not public.prosm_time_plan_allows(new.organization_id, 'roles_manager')
       and exists (select 1 from users u join roles r on r.id = u.role_id
                   where u.organization_id = new.organization_id and u.is_active and not u.is_owner
                     and r.role_key = 'manager' and u.id <> new.id) then
        raise exception 'PLAN MANAGER LIMIT REACHED';
    end if;
    if v_key = 'read_only' and not public.prosm_time_plan_allows(new.organization_id, 'roles_all') then
        raise exception 'FEATURE NOT IN PLAN: roles_all';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_guard_role_plan() from public, anon, authenticated;

create or replace function public.prosm_time_check_role_plan(p_org uuid, p_role_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if p_role_key = 'supervisor' and not public.prosm_time_plan_allows(p_org, 'roles_manager') then
        raise exception 'FEATURE NOT IN PLAN: roles_manager';
    end if;
    if p_role_key = 'manager' and not public.prosm_time_plan_allows(p_org, 'roles_manager')
       and exists (select 1 from users u join roles r on r.id = u.role_id
                   where u.organization_id = p_org and u.is_active and not u.is_owner and r.role_key = 'manager') then
        raise exception 'PLAN MANAGER LIMIT REACHED';
    end if;
    if p_role_key = 'read_only' and not public.prosm_time_plan_allows(p_org, 'roles_all') then
        raise exception 'FEATURE NOT IN PLAN: roles_all';
    end if;
end;
$$;
revoke all on function public.prosm_time_check_role_plan(uuid, text) from public, anon, authenticated;

-- 7. External workers: the number the licence allows, from Platform Manager.
alter table public.license_activation_state add column if not exists max_external_workers integer
    check (max_external_workers is null or max_external_workers >= 0);

drop function if exists public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz, uuid);

create or replace function public.refresh_prosm_time_license_state(
    p_organization_id uuid,
    p_status text,
    p_max_users integer,
    p_max_devices integer,
    p_expires_at timestamptz,
    p_plan_id uuid default null,
    p_max_external_workers integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if p_status not in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED') then
        raise exception 'INVALID LICENSE STATUS';
    end if;

    update license_activation_state
    set
        status = p_status,
        max_users = p_max_users,
        max_devices = p_max_devices,
        max_external_workers = p_max_external_workers,
        plan_id = coalesce(p_plan_id, plan_id),
        -- A renewal in Platform Manager extends the trial: its notices start again for the new end date.
        trial_reminder_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() + interval '7 days' then null else trial_reminder_sent_at end,
        trial_ended_notice_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() then null else trial_ended_notice_sent_at end,
        expires_at = p_expires_at,
        last_verified_at = now(),
        updated_at = now()
    where organization_id = p_organization_id;

    if not found then
        raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION';
    end if;

    return jsonb_build_object('success', true, 'organizationId', p_organization_id, 'status', p_status);
exception
    when others then
        raise exception 'REFRESH PROSM TIME LICENSE STATE FAILED: %', sqlerrm;
end;
$function$;
revoke all on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz, uuid, integer) to service_role;

-- The limit itself, on the workers table (legacy organisations and trials have none).
create or replace function public.prosm_time_external_worker_limit(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
    select l.max_external_workers
    from license_activation_state l
    join entitlements e on e.organization_id = l.organization_id
    where l.organization_id = p_org and e.plan <> 'legacy' and e.status <> 'trial';
$$;
revoke all on function public.prosm_time_external_worker_limit(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_enforce_external_workers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_max integer;
begin
    if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return new; end if;
    v_max := public.prosm_time_external_worker_limit(new.organization_id);
    if v_max is not null and (select count(*) from site_workers where organization_id = new.organization_id and status = 'active' and id <> new.id) >= v_max then
        raise exception 'PLAN EXTERNAL WORKER LIMIT REACHED';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_enforce_external_workers() from public, anon, authenticated;
drop trigger if exists site_workers_enforce_plan on public.site_workers;
create trigger site_workers_enforce_plan before insert or update of status on public.site_workers
for each row execute function public.prosm_time_enforce_external_workers();

-- 8. The owner's plan screen: external workers and what is billed (employees + one per 10 workers).
do $patch$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_plan_status()'::regprocedure);
    v_anchor text := '''maxSites'', v_plan.max_sites';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'plan status anchor not found'; end if;
    v_def := replace(v_def, v_anchor, v_anchor || ',
        ''externalWorkers'', (select count(*) from site_workers where organization_id = v_org and status = ''active''),
        ''maxExternalWorkers'', (select max_external_workers from license_activation_state where organization_id = v_org),
        ''billedUsers'', (select count(*) from users where organization_id = v_org and is_active)
                       + ceil((select count(*) from site_workers where organization_id = v_org and status = ''active'') / 10.0)::integer,
        ''historyDays'', v_plan.history_days');
    execute v_def;
end;
$patch$;

commit;
