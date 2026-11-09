-- 2026-11-08 B-07: external labour pay, reports, policy and approval.
--
-- External workers (site_workers) are not employees or users: nothing here touches payroll
-- cycles, payroll reports or employee reports, and no payroll.* permission opens any of it (nor
-- the reverse). Model:
--   * Rate: amount + currency + unit. External workers may be paid by the day, week, month or
--     year (and by the hour, as before). Stored in worker_pay_rates (history, effective dates);
--     the new units are allowed for external workers only, so employee rates, labour cost and the
--     rates export keep their meaning.
--   * A pay run covers a period (and optionally one site). Work quantity is in the rate's own
--     unit (D9): for hourly and daily rates it is suggested from the kiosk attendance (closed
--     sessions in the period - hours, or days with attendance); for weekly, monthly and yearly
--     rates it is entered by an authorised person. Who entered it, when, and why it differs from
--     the suggestion are kept.
--   * Gross = rate x quantity. The organisation's own policy adds and deducts items (a fixed amount
--     in a currency, or a percentage of gross) before approval; no country rules in code.
--   * Individual adjustments before approval: a deduction or an addition, as an amount, or as a
--     quantity of days for daily rates and for monthly/yearly rates converted with the
--     organisation's day-rate rule (D10-A: fixed divisor, default 30; or calendar days; or working
--     days in the period). Weekly and hourly: amount only (D10-B, later). A reason is mandatory.
--   * Approval freezes a snapshot (rates, quantities, the policy and the rule used, results);
--     changes after that need a reopen with a reason. A draft report is marked as a draft.
--   * Totals are per currency; currencies are never added together.
--   * Permissions external_labor.view_pay / manage / manage_policy / adjust / approve / export; the
--     Owner holds them; scope follows the worker's site for managers with managed sites. The older
--     external_labor.view (managers see the external workers on the dashboard) shows no pay.
-- Tables are RPC-only (RLS on, no client grants).

begin;

-- Permissions -----------------------------------------------------------------------------------
insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('external_labor.view_pay', 'external_labor', 'VIEW', 'View external labour pay', 'See external workers'' rates, pay runs and reports in scope.'),
    ('external_labor.manage', 'external_labor', 'EDIT', 'Manage external labour pay', 'Set rates, prepare pay runs and enter work quantities.'),
    ('external_labor.manage_policy', 'external_labor', 'ADMINISTER', 'External labour pay policy', 'Deduction and addition items, and the day-rate rule.'),
    ('external_labor.adjust', 'external_labor', 'EDIT', 'Adjust external labour pay', 'Add an individual deduction or addition, with a reason.'),
    ('external_labor.approve', 'external_labor', 'APPROVE', 'Approve external labour pay', 'Approve a pay run, and reopen it with a reason.'),
    ('external_labor.export', 'external_labor', 'EXPORT', 'Export external labour pay', 'Export external labour pay reports.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
where r.role_key = 'owner' and p.permission_key like 'external_labor.%' and p.permission_key <> 'external_labor.view'
on conflict (role_id, permission_id) do nothing;

-- Rates -----------------------------------------------------------------------------------------
do $$
declare
    v_name text;
begin
    for v_name in select conname from pg_constraint where conrelid = 'public.worker_pay_rates'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%rate_type%' loop
        execute format('alter table public.worker_pay_rates drop constraint %I', v_name);
    end loop;
end $$;
alter table public.worker_pay_rates add constraint worker_pay_rates_rate_type_check check (
    rate_type in ('HOURLY', 'MONTHLY') or (site_worker_id is not null and rate_type in ('DAILY', 'WEEKLY', 'YEARLY')));
alter table public.worker_pay_rates add constraint worker_pay_rates_currency_check check (currency ~ '^[A-Z]{3}$') not valid;

-- Scope -----------------------------------------------------------------------------------------
create or replace function public.prosm_time_external_allows(p_key text, p_site uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_id() is not null
       and public.prosm_time_plan_allows(public.current_prosm_time_organization_id(), 'kiosk')
       and (
           public.current_prosm_time_user_is_owner()
           or p_key = any(public.prosm_time_delegated_permissions(public.current_prosm_time_user_id()))
           or (
               public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), p_key)
               and (
                   cardinality(public.current_prosm_time_managed_site_ids()) = 0
                   or coalesce(p_site = any(public.current_prosm_time_managed_site_ids()), false)
               )
           )
       );
$$;
revoke all on function public.prosm_time_external_allows(text, uuid) from public, anon, authenticated;

create or replace function public.prosm_time_external_require(p_key text, p_site uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('kiosk');
    if not public.prosm_time_external_allows(p_key, p_site) then
        raise exception 'EXTERNAL LABOR AUTHORITY REQUIRED: %', p_key;
    end if;
end;
$$;
revoke all on function public.prosm_time_external_require(text, uuid) from public, anon, authenticated;

-- Settings (the day-rate rule, D10-A) -----------------------------------------------------------
create table if not exists public.external_labor_settings (
    organization_id uuid primary key references public.organizations(id) on delete cascade,
    day_rate_basis text not null default 'fixed' check (day_rate_basis in ('fixed', 'calendar', 'working')),
    fixed_divisor numeric(6,2) not null default 30 check (fixed_divisor > 0 and fixed_divisor <= 31),
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now()
);
alter table public.external_labor_settings enable row level security;
revoke all on public.external_labor_settings from anon, authenticated;

create or replace function public.get_prosm_time_external_labor_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_row external_labor_settings%rowtype;
begin
    if not (public.prosm_time_external_allows('external_labor.view_pay', null) or public.prosm_time_external_allows('external_labor.manage_policy', null)
            or exists (select 1 from unnest(public.current_prosm_time_managed_site_ids()) s where public.prosm_time_external_allows('external_labor.view_pay', s))) then
        raise exception 'EXTERNAL LABOR AUTHORITY REQUIRED: external_labor.view';
    end if;
    insert into external_labor_settings (organization_id) values (v_org) on conflict do nothing;
    select * into v_row from external_labor_settings where organization_id = v_org;
    return jsonb_build_object('dayRateBasis', v_row.day_rate_basis, 'fixedDivisor', v_row.fixed_divisor, 'updatedAt', v_row.updated_at,
                              'canManagePolicy', public.prosm_time_external_allows('external_labor.manage_policy', null));
end;
$$;

create or replace function public.save_prosm_time_external_labor_settings(p_day_rate_basis text, p_fixed_divisor numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    perform public.prosm_time_external_require('external_labor.manage_policy', null);
    if p_day_rate_basis not in ('fixed', 'calendar', 'working') then raise exception 'INVALID DAY RATE BASIS'; end if;
    if p_fixed_divisor is null or p_fixed_divisor <= 0 or p_fixed_divisor > 31 then raise exception 'THE DIVISOR MUST BE BETWEEN 1 AND 31'; end if;
    insert into external_labor_settings (organization_id, day_rate_basis, fixed_divisor, updated_by, updated_at)
    values (v_org, p_day_rate_basis, p_fixed_divisor, public.current_prosm_time_user_id(), now())
    on conflict (organization_id) do update set day_rate_basis = excluded.day_rate_basis, fixed_divisor = excluded.fixed_divisor,
                                              updated_by = excluded.updated_by, updated_at = now();
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, public.current_prosm_time_user_id(), 'EXTERNAL_LABOR_SETTINGS_CHANGED', 'external_labor_settings', v_org,
            'Changed the external labour day-rate rule.', jsonb_build_object('dayRateBasis', p_day_rate_basis, 'fixedDivisor', p_fixed_divisor));
    return public.get_prosm_time_external_labor_settings();
end;
$$;

-- Rates: set and read (history) -----------------------------------------------------------------
create or replace function public.set_prosm_time_external_rate(p_worker_id uuid, p_amount numeric, p_currency text, p_unit text, p_effective_from date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_worker site_workers%rowtype;
    v_currency text := upper(trim(coalesce(p_currency, '')));
    v_from date := coalesce(p_effective_from, current_date);
    v_id uuid;
begin
    select * into v_worker from site_workers where id = p_worker_id and organization_id = v_org;
    if v_worker.id is null then raise exception 'EXTERNAL WORKER NOT FOUND'; end if;
    perform public.prosm_time_external_require('external_labor.manage', v_worker.site_id);
    if p_unit not in ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') then raise exception 'INVALID RATE UNIT'; end if;
    if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 then raise exception 'THE RATE MUST BE GREATER THAN ZERO'; end if;
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'INVALID CURRENCY'; end if;
    if exists (select 1 from external_labor_run_workers rw join external_labor_runs r on r.id = rw.run_id
               where rw.site_worker_id = p_worker_id and r.status = 'approved' and r.period_end >= v_from) then
        raise exception 'AN APPROVED PAY RUN ALREADY COVERS THIS DATE - REOPEN IT FIRST';
    end if;
    -- a later rate replaced from this date on; the open one closes the day before
    delete from worker_pay_rates where site_worker_id = p_worker_id and effective_from >= v_from;
    update worker_pay_rates set effective_to = v_from - 1 where site_worker_id = p_worker_id and (effective_to is null or effective_to >= v_from);
    insert into worker_pay_rates (organization_id, site_worker_id, rate_type, rate_amount, currency, effective_from, created_by)
    values (v_org, p_worker_id, p_unit, round(p_amount, 2), v_currency, v_from, public.current_prosm_time_user_id())
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, public.current_prosm_time_user_id(), 'EXTERNAL_WORKER_RATE_SET', 'site_workers', p_worker_id, 'Set an external worker''s rate.',
            jsonb_build_object('unit', p_unit, 'amount', round(p_amount, 2), 'currency', v_currency, 'effectiveFrom', v_from));
    return jsonb_build_object('success', true, 'rateId', v_id);
end;
$$;

create or replace function public.list_prosm_time_external_rates()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'workerId', w.id, 'name', w.full_name, 'workerNumber', w.worker_number, 'contractorName', w.contractor_name, 'siteId', w.site_id,
        'siteName', s.name, 'status', w.status,
        'current', (select jsonb_build_object('unit', r.rate_type, 'amount', r.rate_amount, 'currency', r.currency, 'effectiveFrom', r.effective_from)
                    from worker_pay_rates r where r.site_worker_id = w.id and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)
                    order by r.effective_from desc limit 1),
        'history', coalesce((select jsonb_agg(jsonb_build_object('unit', r.rate_type, 'amount', r.rate_amount, 'currency', r.currency, 'effectiveFrom', r.effective_from, 'effectiveTo', r.effective_to)
                                              order by r.effective_from desc)
                             from worker_pay_rates r where r.site_worker_id = w.id), '[]'::jsonb),
        'canManage', public.prosm_time_external_allows('external_labor.manage', w.site_id)
    ) order by w.full_name), '[]'::jsonb)
    from site_workers w left join sites s on s.id = w.site_id
    where w.organization_id = public.current_prosm_time_organization_id()
      and public.prosm_time_external_allows('external_labor.view_pay', w.site_id);
$$;

-- Policy ----------------------------------------------------------------------------------------
create table if not exists public.external_labor_policy_items (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 120),
    kind text not null check (kind in ('deduction', 'addition')),
    calc text not null check (calc in ('fixed', 'percent')),
    value numeric(14,2) not null check (value > 0),
    currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
    is_active boolean not null default true,
    sort_order integer not null default 0,
    row_version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((calc = 'fixed' and currency is not null) or (calc = 'percent' and currency is null and value <= 100))
);
create index if not exists external_labor_policy_items_org_idx on public.external_labor_policy_items (organization_id);
alter table public.external_labor_policy_items enable row level security;
revoke all on public.external_labor_policy_items from anon, authenticated;

create or replace function public.list_prosm_time_external_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.prosm_time_external_allows('external_labor.view_pay', null) or public.prosm_time_external_allows('external_labor.manage_policy', null)
            or exists (select 1 from unnest(public.current_prosm_time_managed_site_ids()) s where public.prosm_time_external_allows('external_labor.view_pay', s))) then
        raise exception 'EXTERNAL LABOR AUTHORITY REQUIRED: external_labor.view';
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'calc', calc, 'value', value, 'currency', currency,
                                                         'isActive', is_active, 'sortOrder', sort_order, 'rowVersion', row_version) order by sort_order, name)
                     from external_labor_policy_items where organization_id = public.current_prosm_time_organization_id()), '[]'::jsonb);
end;
$$;

create or replace function public.save_prosm_time_external_policy_item(p_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_calc text := p_item ->> 'calc';
    v_currency text := nullif(upper(trim(coalesce(p_item ->> 'currency', ''))), '');
    v_value numeric := (p_item ->> 'value')::numeric;
    v_id uuid;
begin
    perform public.prosm_time_external_require('external_labor.manage_policy', null);
    if coalesce(length(trim(p_item ->> 'name')), 0) = 0 then raise exception 'A NAME IS REQUIRED'; end if;
    if (p_item ->> 'kind') not in ('deduction', 'addition') then raise exception 'INVALID POLICY ITEM KIND'; end if;
    if v_calc not in ('fixed', 'percent') then raise exception 'INVALID POLICY ITEM CALCULATION'; end if;
    if v_value is null or v_value <= 0 then raise exception 'THE VALUE MUST BE GREATER THAN ZERO'; end if;
    if v_calc = 'percent' and v_value > 100 then raise exception 'A PERCENTAGE CANNOT EXCEED 100'; end if;
    if v_calc = 'fixed' and (v_currency is null or v_currency !~ '^[A-Z]{3}$') then raise exception 'A FIXED AMOUNT NEEDS A CURRENCY'; end if;
    if p_id is null then
        insert into external_labor_policy_items (organization_id, name, kind, calc, value, currency, is_active, sort_order)
        values (v_org, trim(p_item ->> 'name'), p_item ->> 'kind', v_calc, round(v_value, 2), case when v_calc = 'fixed' then v_currency end,
                coalesce((p_item ->> 'isActive')::boolean, true), coalesce((p_item ->> 'sortOrder')::int, 0))
        returning id into v_id;
    else
        update external_labor_policy_items set name = trim(p_item ->> 'name'), kind = p_item ->> 'kind', calc = v_calc, value = round(v_value, 2),
               currency = case when v_calc = 'fixed' then v_currency end, is_active = coalesce((p_item ->> 'isActive')::boolean, is_active),
               sort_order = coalesce((p_item ->> 'sortOrder')::int, sort_order), row_version = row_version + 1, updated_at = now()
        where id = p_id and organization_id = v_org
          and (p_item ->> 'rowVersion' is null or row_version = (p_item ->> 'rowVersion')::int)
        returning id into v_id;
        if v_id is null then raise exception 'THIS ITEM WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, public.current_prosm_time_user_id(), 'EXTERNAL_LABOR_POLICY_CHANGED', 'external_labor_policy_items', v_id,
            'Changed an external labour policy item.', p_item - 'rowVersion');
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;

-- Pay runs ---------------------------------------------------------------------------------------
create table if not exists public.external_labor_runs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    title text not null check (length(trim(title)) between 1 and 160),
    period_start date not null,
    period_end date not null,
    status text not null default 'draft' check (status in ('draft', 'approved')),
    run_version integer not null default 1,
    created_by uuid references public.users(id) on delete set null,
    approved_by uuid references public.users(id) on delete set null,
    approved_at timestamptz,
    reopen_reason text,
    row_version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (period_end >= period_start and period_end - period_start <= 366)
);
create index if not exists external_labor_runs_org_idx on public.external_labor_runs (organization_id, period_start desc);

create table if not exists public.external_labor_run_workers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    run_id uuid not null references public.external_labor_runs(id) on delete cascade,
    site_worker_id uuid references public.site_workers(id) on delete set null,
    full_name text not null,
    worker_number text,
    contractor_name text,
    site_id uuid,
    site_name text,
    rate_unit text not null check (rate_unit in ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')),
    rate_amount numeric(14,2) not null check (rate_amount > 0),
    currency text not null,
    attendance_hours numeric(10,2) not null default 0,
    attendance_days integer not null default 0,
    quantity numeric(10,2) check (quantity is null or quantity >= 0),
    quantity_source text not null default 'manual' check (quantity_source in ('attendance', 'manual')),
    quantity_note text,
    quantity_by uuid references public.users(id) on delete set null,
    quantity_at timestamptz,
    row_version integer not null default 1,
    unique (run_id, site_worker_id)
);
create index if not exists external_labor_run_workers_run_idx on public.external_labor_run_workers (run_id);
create index if not exists external_labor_run_workers_worker_idx on public.external_labor_run_workers (site_worker_id);

create table if not exists public.external_labor_adjustments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    run_id uuid not null references public.external_labor_runs(id) on delete cascade,
    run_worker_id uuid not null references public.external_labor_run_workers(id) on delete cascade,
    kind text not null check (kind in ('deduction', 'addition')),
    input_mode text not null check (input_mode in ('amount', 'quantity')),
    quantity numeric(10,2) check (quantity is null or quantity > 0),
    day_rate numeric(14,4),
    amount numeric(14,2) not null check (amount > 0),
    reason text not null check (length(trim(reason)) between 3 and 500),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create index if not exists external_labor_adjustments_run_idx on public.external_labor_adjustments (run_id);

create table if not exists public.external_labor_run_snapshots (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    run_id uuid not null references public.external_labor_runs(id) on delete cascade,
    run_version integer not null,
    data jsonb not null,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    primary key (run_id, run_version)
);

alter table public.external_labor_runs enable row level security;
alter table public.external_labor_run_workers enable row level security;
alter table public.external_labor_adjustments enable row level security;
alter table public.external_labor_run_snapshots enable row level security;
revoke all on public.external_labor_runs, public.external_labor_run_workers, public.external_labor_adjustments, public.external_labor_run_snapshots from anon, authenticated;

create or replace function public.prosm_time_external_run(p_run_id uuid, p_lock boolean default false)
returns public.external_labor_runs
language plpgsql
security definer
set search_path = public
as $$
declare
    v_run external_labor_runs%rowtype;
begin
    if p_lock then
        select * into v_run from external_labor_runs where id = p_run_id and organization_id = public.current_prosm_time_organization_id() for update;
    else
        select * into v_run from external_labor_runs where id = p_run_id and organization_id = public.current_prosm_time_organization_id();
    end if;
    if v_run.id is null then raise exception 'PAY RUN NOT FOUND'; end if;
    return v_run;
end;
$$;
revoke all on function public.prosm_time_external_run(uuid, boolean) from public, anon, authenticated;

-- the day count used to turn a monthly/yearly rate into a day rate (D10-A)
create or replace function public.prosm_time_external_day_divisor(p_org uuid, p_site uuid, p_start date, p_end date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select case s.day_rate_basis
               when 'calendar' then (p_end - p_start + 1)::numeric
               when 'working' then greatest(1, (
                   select count(*) from generate_series(p_start, p_end, interval '1 day') d
                   where not (extract(dow from d)::smallint = any(coalesce((select st.rest_days from sites st where st.id = p_site),
                                                                           (select os.rest_days from organization_settings os where os.organization_id = p_org),
                                                                           array[]::smallint[])))
                     and not exists (select 1 from public_holidays h where h.organization_id = p_org and (h.site_id is null or h.site_id = p_site)
                                     and d::date between h.start_date and h.end_date)))::numeric
               else s.fixed_divisor end
    from (select coalesce((select day_rate_basis from external_labor_settings where organization_id = p_org), 'fixed') as day_rate_basis,
                 coalesce((select fixed_divisor from external_labor_settings where organization_id = p_org), 30) as fixed_divisor) s;
$$;
revoke all on function public.prosm_time_external_day_divisor(uuid, uuid, date, date) from public, anon, authenticated;

-- kiosk attendance of one worker in the period (closed sessions, by the clock-in day)
create or replace function public.prosm_time_external_attendance(p_worker uuid, p_start date, p_end date)
returns table (hours numeric, days integer)
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(round((sum(extract(epoch from (a.clock_out_at - a.clock_in_at))) / 3600)::numeric, 2), 0),
           count(distinct (a.clock_in_at at time zone public.prosm_time_site_timezone(a.site_id, a.organization_id))::date)::int
    from site_worker_attendance a
    where a.site_worker_id = p_worker and a.clock_out_at is not null
      and (a.clock_in_at at time zone public.prosm_time_site_timezone(a.site_id, a.organization_id))::date between p_start and p_end;
$$;
revoke all on function public.prosm_time_external_attendance(uuid, date, date) from public, anon, authenticated;

create or replace function public.create_prosm_time_external_run(p_period_start date, p_period_end date, p_site_id uuid default null, p_title text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_caller uuid := public.current_prosm_time_user_id();
    v_run_id uuid;
    v_worker record;
    v_rate worker_pay_rates%rowtype;
    v_att record;
    v_added integer := 0;
    v_skipped jsonb := '[]'::jsonb;
begin
    perform public.prosm_time_external_require('external_labor.manage', p_site_id);
    if p_period_start is null or p_period_end is null or p_period_end < p_period_start then raise exception 'INVALID PERIOD'; end if;
    if p_period_end - p_period_start > 366 then raise exception 'A PAY RUN COVERS AT MOST A YEAR'; end if;
    if p_site_id is not null and not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;

    insert into external_labor_runs (organization_id, site_id, title, period_start, period_end, created_by)
    values (v_org, p_site_id, coalesce(nullif(trim(p_title), ''), to_char(p_period_start, 'YYYY-MM-DD') || ' - ' || to_char(p_period_end, 'YYYY-MM-DD')),
            p_period_start, p_period_end, v_caller)
    returning id into v_run_id;

    for v_worker in
        select w.*, s.name as site_name from site_workers w left join sites s on s.id = w.site_id
        where w.organization_id = v_org and w.status = 'active'
          and (p_site_id is null or w.site_id = p_site_id)
          and public.prosm_time_external_allows('external_labor.manage', w.site_id)
        order by w.full_name
    loop
        if exists (select 1 from external_labor_run_workers rw join external_labor_runs r on r.id = rw.run_id
                   where rw.site_worker_id = v_worker.id and r.id <> v_run_id and r.period_start <= p_period_end and r.period_end >= p_period_start) then
            v_skipped := v_skipped || jsonb_build_object('workerId', v_worker.id, 'name', v_worker.full_name, 'reason', 'in_other_run');
            continue;
        end if;
        select * into v_rate from worker_pay_rates
        where site_worker_id = v_worker.id and effective_from <= p_period_end and (effective_to is null or effective_to >= p_period_end)
        order by effective_from desc limit 1;
        if v_rate.id is null then
            v_skipped := v_skipped || jsonb_build_object('workerId', v_worker.id, 'name', v_worker.full_name, 'reason', 'no_rate');
            continue;
        end if;
        select * into v_att from public.prosm_time_external_attendance(v_worker.id, p_period_start, p_period_end);
        insert into external_labor_run_workers (organization_id, run_id, site_worker_id, full_name, worker_number, contractor_name, site_id, site_name,
                                                rate_unit, rate_amount, currency, attendance_hours, attendance_days, quantity, quantity_source)
        values (v_org, v_run_id, v_worker.id, v_worker.full_name, v_worker.worker_number, v_worker.contractor_name, v_worker.site_id, v_worker.site_name,
                v_rate.rate_type, v_rate.rate_amount, v_rate.currency, v_att.hours, v_att.days,
                case v_rate.rate_type when 'HOURLY' then v_att.hours when 'DAILY' then v_att.days end,
                case when v_rate.rate_type in ('HOURLY', 'DAILY') then 'attendance' else 'manual' end);
        v_added := v_added + 1;
    end loop;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, v_caller, 'EXTERNAL_PAY_RUN_CREATED', 'external_labor_runs', v_run_id, 'Created an external labour pay run.',
            jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'siteId', p_site_id, 'workers', v_added, 'skipped', v_skipped));
    return jsonb_build_object('success', true, 'runId', v_run_id, 'added', v_added, 'skipped', v_skipped);
end;
$$;

create or replace function public.set_prosm_time_external_quantity(p_run_worker_id uuid, p_quantity numeric, p_note text default null, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rw external_labor_run_workers%rowtype;
    v_run external_labor_runs%rowtype;
    v_suggested numeric;
    v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
    select * into v_rw from external_labor_run_workers where id = p_run_worker_id and organization_id = public.current_prosm_time_organization_id();
    if v_rw.id is null then raise exception 'PAY RUN WORKER NOT FOUND'; end if;
    v_run := public.prosm_time_external_run(v_rw.run_id, true);
    perform public.prosm_time_external_require('external_labor.manage', v_rw.site_id);
    if v_run.status <> 'draft' then raise exception 'THIS PAY RUN IS APPROVED - REOPEN IT FIRST'; end if;
    if p_expected_version is not null and p_expected_version <> v_rw.row_version then raise exception 'THIS LINE WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    if p_quantity is null or p_quantity < 0 or p_quantity > 100000 then raise exception 'INVALID QUANTITY'; end if;
    v_suggested := case v_rw.rate_unit when 'HOURLY' then v_rw.attendance_hours when 'DAILY' then v_rw.attendance_days end;
    if v_suggested is not null and round(p_quantity, 2) <> v_suggested and v_note is null then
        raise exception 'A REASON IS REQUIRED WHEN THE QUANTITY DIFFERS FROM THE ATTENDANCE';
    end if;
    update external_labor_run_workers set quantity = round(p_quantity, 2),
           quantity_source = case when v_suggested is not null and round(p_quantity, 2) = v_suggested then 'attendance' else 'manual' end,
           quantity_note = v_note, quantity_by = public.current_prosm_time_user_id(), quantity_at = now(), row_version = row_version + 1
    where id = v_rw.id;
    update external_labor_runs set row_version = row_version + 1, updated_at = now() where id = v_run.id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_run.organization_id, public.current_prosm_time_user_id(), 'EXTERNAL_PAY_QUANTITY_SET', 'external_labor_runs', v_run.id,
            'Entered an external worker''s work quantity.',
            jsonb_build_object('workerId', v_rw.site_worker_id, 'from', v_rw.quantity, 'to', round(p_quantity, 2), 'unit', v_rw.rate_unit, 'note', v_note));
    return jsonb_build_object('success', true);
end;
$$;

create or replace function public.add_prosm_time_external_adjustment(p_run_worker_id uuid, p_kind text, p_input_mode text, p_value numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rw external_labor_run_workers%rowtype;
    v_run external_labor_runs%rowtype;
    v_day_rate numeric;
    v_amount numeric;
    v_id uuid;
begin
    select * into v_rw from external_labor_run_workers where id = p_run_worker_id and organization_id = public.current_prosm_time_organization_id();
    if v_rw.id is null then raise exception 'PAY RUN WORKER NOT FOUND'; end if;
    v_run := public.prosm_time_external_run(v_rw.run_id, true);
    perform public.prosm_time_external_require('external_labor.adjust', v_rw.site_id);
    if v_run.status <> 'draft' then raise exception 'THIS PAY RUN IS APPROVED - REOPEN IT FIRST'; end if;
    if p_kind not in ('deduction', 'addition') then raise exception 'INVALID ADJUSTMENT KIND'; end if;
    if p_input_mode not in ('amount', 'quantity') then raise exception 'INVALID ADJUSTMENT INPUT'; end if;
    if p_value is null or p_value <= 0 or p_value > 10000000000 then raise exception 'THE VALUE MUST BE GREATER THAN ZERO'; end if;
    if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A REASON IS REQUIRED'; end if;
    if p_input_mode = 'quantity' then
        -- days only: daily rates directly; monthly and yearly through the day-rate rule (D10-A)
        v_day_rate := case v_rw.rate_unit
            when 'DAILY' then v_rw.rate_amount
            when 'MONTHLY' then v_rw.rate_amount / public.prosm_time_external_day_divisor(v_run.organization_id, v_rw.site_id, v_run.period_start, v_run.period_end)
            when 'YEARLY' then v_rw.rate_amount / 12 / public.prosm_time_external_day_divisor(v_run.organization_id, v_rw.site_id, v_run.period_start, v_run.period_end)
        end;
        if v_day_rate is null then raise exception 'ENTER THIS ADJUSTMENT AS AN AMOUNT FOR THIS RATE UNIT'; end if;
        v_amount := round(p_value * v_day_rate, 2);
    else
        v_amount := round(p_value, 2);
    end if;
    if v_amount <= 0 then raise exception 'THE VALUE MUST BE GREATER THAN ZERO'; end if;
    insert into external_labor_adjustments (organization_id, run_id, run_worker_id, kind, input_mode, quantity, day_rate, amount, reason, created_by)
    values (v_run.organization_id, v_run.id, v_rw.id, p_kind, p_input_mode, case when p_input_mode = 'quantity' then round(p_value, 2) end,
            round(v_day_rate, 4), v_amount, trim(p_reason), public.current_prosm_time_user_id())
    returning id into v_id;
    update external_labor_runs set row_version = row_version + 1, updated_at = now() where id = v_run.id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, reason, context)
    values (v_run.organization_id, public.current_prosm_time_user_id(), 'EXTERNAL_PAY_ADJUSTMENT_ADDED', 'external_labor_runs', v_run.id,
            'Added an individual external labour pay adjustment.', trim(p_reason),
            jsonb_build_object('workerId', v_rw.site_worker_id, 'kind', p_kind, 'inputMode', p_input_mode, 'value', p_value, 'amount', v_amount, 'currency', v_rw.currency));
    return jsonb_build_object('success', true, 'id', v_id, 'amount', v_amount);
end;
$$;

create or replace function public.delete_prosm_time_external_adjustment(p_adjustment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_adj external_labor_adjustments%rowtype;
    v_run external_labor_runs%rowtype;
    v_site uuid;
begin
    select * into v_adj from external_labor_adjustments where id = p_adjustment_id and organization_id = public.current_prosm_time_organization_id();
    if v_adj.id is null then raise exception 'ADJUSTMENT NOT FOUND'; end if;
    v_run := public.prosm_time_external_run(v_adj.run_id, true);
    select site_id into v_site from external_labor_run_workers where id = v_adj.run_worker_id;
    perform public.prosm_time_external_require('external_labor.adjust', v_site);
    if v_run.status <> 'draft' then raise exception 'THIS PAY RUN IS APPROVED - REOPEN IT FIRST'; end if;
    delete from external_labor_adjustments where id = v_adj.id;
    update external_labor_runs set row_version = row_version + 1, updated_at = now() where id = v_run.id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_run.organization_id, public.current_prosm_time_user_id(), 'EXTERNAL_PAY_ADJUSTMENT_REMOVED', 'external_labor_runs', v_run.id,
            'Removed an individual external labour pay adjustment.', to_jsonb(v_adj) - 'organization_id');
    return jsonb_build_object('success', true);
end;
$$;

-- The figures of a run: live while a draft, the stored snapshot once approved.
create or replace function public.prosm_time_external_compute(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with run as (select * from external_labor_runs where id = p_run_id),
    policy as (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'calc', calc, 'value', value, 'currency', currency) order by sort_order, name), '[]'::jsonb) as items
        from external_labor_policy_items where organization_id = (select organization_id from run) and is_active
    ),
    workers as (
        select rw.*, case when rw.quantity is null then null else round(rw.rate_amount * rw.quantity, 2) end as gross
        from external_labor_run_workers rw where rw.run_id = p_run_id
    ),
    lines as (
        select w.id,
               coalesce((select jsonb_agg(jsonb_build_object('name', p ->> 'name', 'kind', p ->> 'kind', 'calc', p ->> 'calc', 'value', (p ->> 'value')::numeric,
                                                             'amount', case when p ->> 'calc' = 'fixed' then (p ->> 'value')::numeric
                                                                            else round(coalesce(w.gross, 0) * (p ->> 'value')::numeric / 100, 2) end))
                         from jsonb_array_elements((select items from policy)) p
                         where p ->> 'calc' = 'percent' or p ->> 'currency' = w.currency), '[]'::jsonb) as policy_lines,
               coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'inputMode', a.input_mode, 'quantity', a.quantity, 'dayRate', a.day_rate,
                                                             'amount', a.amount, 'reason', a.reason, 'createdAt', a.created_at,
                                                             'createdBy', (select full_name from users where id = a.created_by)) order by a.created_at)
                         from external_labor_adjustments a where a.run_worker_id = w.id), '[]'::jsonb) as adjustments
        from workers w
    ),
    figures as (
        select w.*, l.policy_lines, l.adjustments,
               coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(l.policy_lines) x where x ->> 'kind' = 'addition'), 0)
             + coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(l.adjustments) x where x ->> 'kind' = 'addition'), 0) as additions,
               coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(l.policy_lines) x where x ->> 'kind' = 'deduction'), 0)
             + coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(l.adjustments) x where x ->> 'kind' = 'deduction'), 0) as deductions
        from workers w join lines l on l.id = w.id
    )
    select jsonb_build_object(
        'rules', jsonb_build_object(
            'dayRateBasis', coalesce((select day_rate_basis from external_labor_settings where organization_id = (select organization_id from run)), 'fixed'),
            'fixedDivisor', coalesce((select fixed_divisor from external_labor_settings where organization_id = (select organization_id from run)), 30),
            'policy', (select items from policy)),
        'workers', coalesce((select jsonb_agg(jsonb_build_object(
            'runWorkerId', f.id, 'workerId', f.site_worker_id, 'name', f.full_name, 'workerNumber', f.worker_number, 'contractorName', f.contractor_name,
            'siteId', f.site_id, 'siteName', f.site_name, 'unit', f.rate_unit, 'rate', f.rate_amount, 'currency', f.currency,
            'attendanceHours', f.attendance_hours, 'attendanceDays', f.attendance_days,
            'quantity', f.quantity, 'quantitySource', f.quantity_source, 'quantityNote', f.quantity_note, 'quantityAt', f.quantity_at,
            'quantityBy', (select full_name from users where id = f.quantity_by), 'rowVersion', f.row_version,
            'gross', f.gross, 'policyLines', f.policy_lines, 'adjustments', f.adjustments,
            'additions', f.additions, 'deductions', f.deductions,
            'net', case when f.gross is null then null else round(f.gross + f.additions - f.deductions, 2) end) order by f.full_name)
            from figures f), '[]'::jsonb));
$$;
revoke all on function public.prosm_time_external_compute(uuid) from public, anon, authenticated;

create or replace function public.get_prosm_time_external_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_run external_labor_runs%rowtype := public.prosm_time_external_run(p_run_id);
    v_data jsonb;
    v_workers jsonb;
begin
    if not exists (select 1 from external_labor_run_workers rw where rw.run_id = p_run_id and public.prosm_time_external_allows('external_labor.view_pay', rw.site_id))
       and not public.prosm_time_external_allows('external_labor.view_pay', v_run.site_id) then
        raise exception 'EXTERNAL LABOR AUTHORITY REQUIRED: external_labor.view';
    end if;
    if v_run.status = 'approved' then
        select data into v_data from external_labor_run_snapshots where run_id = p_run_id and run_version = v_run.run_version;
    else
        v_data := public.prosm_time_external_compute(p_run_id);
    end if;
    -- only the workers in the reader's scope; totals per currency from those
    select coalesce(jsonb_agg(w), '[]'::jsonb) into v_workers
    from jsonb_array_elements(v_data -> 'workers') w
    where public.prosm_time_external_allows('external_labor.view_pay', nullif(w ->> 'siteId', '')::uuid);
    return jsonb_build_object(
        'run', jsonb_build_object('id', v_run.id, 'title', v_run.title, 'siteId', v_run.site_id, 'siteName', (select name from sites where id = v_run.site_id),
                                  'periodStart', v_run.period_start, 'periodEnd', v_run.period_end, 'status', v_run.status, 'runVersion', v_run.run_version,
                                  'approvedAt', v_run.approved_at, 'approvedBy', (select full_name from users where id = v_run.approved_by),
                                  'reopenReason', v_run.reopen_reason, 'rowVersion', v_run.row_version, 'isDraft', v_run.status <> 'approved'),
        'rules', v_data -> 'rules',
        'workers', v_workers,
        'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', c, 'gross', g, 'additions', a, 'deductions', d, 'net', n, 'workers', k) order by c)
                            from (select w ->> 'currency' as c, sum((w ->> 'gross')::numeric) as g, sum((w ->> 'additions')::numeric) as a,
                                         sum((w ->> 'deductions')::numeric) as d, sum((w ->> 'net')::numeric) as n, count(*) as k
                                  from jsonb_array_elements(v_workers) w group by 1) t), '[]'::jsonb),
        'can', jsonb_build_object('manage', public.prosm_time_external_allows('external_labor.manage', v_run.site_id),
                                  'adjust', public.prosm_time_external_allows('external_labor.adjust', v_run.site_id),
                                  'approve', public.prosm_time_external_allows('external_labor.approve', v_run.site_id),
                                  'export', public.prosm_time_external_allows('external_labor.export', v_run.site_id)));
end;
$$;

create or replace function public.list_prosm_time_external_runs()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'siteId', r.site_id, 'siteName', s.name, 'periodStart', r.period_start,
                                                 'periodEnd', r.period_end, 'status', r.status, 'runVersion', r.run_version, 'approvedAt', r.approved_at,
                                                 'workers', (select count(*) from external_labor_run_workers rw where rw.run_id = r.id))
                              order by r.period_start desc, r.created_at desc), '[]'::jsonb)
    from external_labor_runs r left join sites s on s.id = r.site_id
    where r.organization_id = public.current_prosm_time_organization_id()
      and (public.prosm_time_external_allows('external_labor.view_pay', r.site_id)
           or exists (select 1 from external_labor_run_workers rw where rw.run_id = r.id and public.prosm_time_external_allows('external_labor.view_pay', rw.site_id)));
$$;

create or replace function public.transition_prosm_time_external_run(p_run_id uuid, p_action text, p_reason text default null, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_run external_labor_runs%rowtype := public.prosm_time_external_run(p_run_id, true);
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if p_expected_version is not null and p_expected_version <> v_run.row_version then raise exception 'THIS PAY RUN WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    if p_action = 'approve' then
        perform public.prosm_time_external_require('external_labor.approve', v_run.site_id);
        if v_run.status <> 'draft' then raise exception 'ONLY A DRAFT PAY RUN IS APPROVED'; end if;
        if not exists (select 1 from external_labor_run_workers where run_id = p_run_id) then raise exception 'THIS PAY RUN HAS NO WORKERS'; end if;
        if exists (select 1 from external_labor_run_workers where run_id = p_run_id and quantity is null) then
            raise exception 'ENTER THE WORK QUANTITY OF EVERY WORKER FIRST';
        end if;
        insert into external_labor_run_snapshots (organization_id, run_id, run_version, data, created_by)
        values (v_run.organization_id, p_run_id, v_run.run_version, public.prosm_time_external_compute(p_run_id), v_caller)
        on conflict (run_id, run_version) do update set data = excluded.data, created_by = excluded.created_by, created_at = now();
        update external_labor_runs set status = 'approved', approved_by = v_caller, approved_at = now(), row_version = row_version + 1, updated_at = now()
        where id = p_run_id;
    elsif p_action = 'reopen' then
        perform public.prosm_time_external_require('external_labor.approve', v_run.site_id);
        if v_run.status <> 'approved' then raise exception 'ONLY AN APPROVED PAY RUN IS REOPENED'; end if;
        if v_reason is null or length(v_reason) < 3 then raise exception 'A REASON IS REQUIRED'; end if;
        update external_labor_runs set status = 'draft', run_version = run_version + 1, reopen_reason = v_reason, approved_by = null, approved_at = null,
               row_version = row_version + 1, updated_at = now()
        where id = p_run_id;
    elsif p_action = 'delete' then
        perform public.prosm_time_external_require('external_labor.manage', v_run.site_id);
        if v_run.status <> 'draft' or exists (select 1 from external_labor_run_snapshots where run_id = p_run_id) then
            raise exception 'ONLY A DRAFT PAY RUN THAT WAS NEVER APPROVED IS DELETED';
        end if;
        delete from external_labor_runs where id = p_run_id;
    else
        raise exception 'INVALID ACTION';
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, reason, context)
    values (v_run.organization_id, v_caller, 'EXTERNAL_PAY_RUN_' || upper(p_action), 'external_labor_runs', p_run_id,
            'External labour pay run: ' || p_action || '.', v_reason, jsonb_build_object('runVersion', v_run.run_version, 'title', v_run.title));
    return jsonb_build_object('success', true);
end;
$$;

create or replace function public.log_prosm_time_external_export(p_run_id uuid, p_format text, p_worker_count integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_run external_labor_runs%rowtype := public.prosm_time_external_run(p_run_id);
begin
    perform public.prosm_time_external_require('external_labor.export', v_run.site_id);
    if p_format not in ('pdf', 'xlsx') then raise exception 'INVALID FORMAT'; end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_run.organization_id, public.current_prosm_time_user_id(), 'EXTERNAL_PAY_EXPORTED', 'external_labor_runs', p_run_id,
            'Exported an external labour pay report.', jsonb_build_object('format', p_format, 'workers', p_worker_count, 'runVersion', v_run.run_version, 'draft', v_run.status <> 'approved'));
    return jsonb_build_object('success', true, 'draft', v_run.status <> 'approved');
end;
$$;

-- grants: the RPCs only
do $$
declare
    v_fn text;
begin
    foreach v_fn in array array[
        'public.get_prosm_time_external_labor_settings()', 'public.save_prosm_time_external_labor_settings(text, numeric)',
        'public.set_prosm_time_external_rate(uuid, numeric, text, text, date)', 'public.list_prosm_time_external_rates()',
        'public.list_prosm_time_external_policy()', 'public.save_prosm_time_external_policy_item(uuid, jsonb)',
        'public.create_prosm_time_external_run(date, date, uuid, text)', 'public.set_prosm_time_external_quantity(uuid, numeric, text, integer)',
        'public.add_prosm_time_external_adjustment(uuid, text, text, numeric, text)', 'public.delete_prosm_time_external_adjustment(uuid)',
        'public.get_prosm_time_external_run(uuid)', 'public.list_prosm_time_external_runs()',
        'public.transition_prosm_time_external_run(uuid, text, text, integer)', 'public.log_prosm_time_external_export(uuid, text, integer)'] loop
        execute format('revoke all on function %s from public, anon', v_fn);
        execute format('grant execute on function %s to authenticated', v_fn);
    end loop;
end $$;

commit;
