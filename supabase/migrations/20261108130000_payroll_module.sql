-- 2026-11-08: Payroll module (owner: "build it as you see right").
--
-- Model: fixed components on the employee's payroll profile (with effective dates) are copied
-- into each cycle; variable lines are entered inside the cycle; every approval stores an
-- immutable snapshot (cycle version v1, v2 ...) that reports and payslips are re-issued from.
--
-- Rules enforced here (not in the screens):
--   * Separate payroll.* permissions; the Owner (and a full delegate) holds them all; nobody else
--     gets them from a role. Scope: a holder with managed sites sees/acts on those sites only;
--     a holder without managed sites (for example an accountant the owner granted) the whole
--     organisation; a partial delegation from the owner carries the owner's whole scope.
--   * Net = earnings - deductions - installments, computed in numeric, rounded to 2 decimals.
--   * A line that counts in the net is always visible on the payslip and the summary, so the
--     visible lines always add up to the net. An "extra" allowance (outside the net) is never on
--     the payslip or the summary; it appears only in the combined salary + allowances report.
--   * One currency per employee; totals are kept per currency, never summed across currencies.
--   * A person is in one cycle per period (no double counting across sites).
--   * Workflow: draft -> in_review -> approved -> locked; approved/locked -> reopened (reason);
--     draft/in_review/reopened -> cancelled (reason). Optimistic locking on cycles and lines.
--     Whoever submitted a cycle does not approve it (the real owner excepted).
--   * Payslips are published only from a locked cycle; reopening unpublishes in the same step.
--   * Export serial numbers are per organisation, never reused, separate from cycle versions.
--   * No country tax tables: taxes and insurance are components the organisation defines.
-- Tables are RPC-only (RLS on, no client grants).

begin;

-- ---------------------------------------------------------------------------------------------
-- Permissions and plan feature
-- ---------------------------------------------------------------------------------------------
insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('payroll.access', 'payroll', 'VIEW', 'Open payroll', 'Open the payroll module.'),
    ('payroll.view', 'payroll', 'VIEW', 'View payroll', 'View payroll cycles and amounts in scope.'),
    ('payroll.manage_profiles', 'payroll', 'EDIT', 'Manage payroll profiles', 'Edit employees'' fixed salary components.'),
    ('payroll.enter_monthly_variables', 'payroll', 'EDIT', 'Enter monthly variables', 'Add and edit variable lines of a cycle.'),
    ('payroll.edit_draft', 'payroll', 'EDIT', 'Prepare payroll cycles', 'Create, recalculate, submit and cancel cycles.'),
    ('payroll.review', 'payroll', 'APPROVE', 'Review payroll', 'Review a submitted cycle and return it.'),
    ('payroll.approve', 'payroll', 'APPROVE', 'Approve payroll', 'Approve and lock a cycle.'),
    ('payroll.reopen', 'payroll', 'ADMINISTER', 'Reopen payroll', 'Reopen an approved cycle, with a reason.'),
    ('payroll.export_summary', 'payroll', 'EXPORT', 'Export payroll summary', 'Export the detailed payroll summary.'),
    ('payroll.export_payslips', 'payroll', 'EXPORT', 'Export payslips', 'Issue individual payslips.'),
    ('payroll.export_combined_allowances', 'payroll', 'EXPORT', 'Export salary and allowances', 'Export the combined salary + allowances report.'),
    ('payroll.manage_permissions', 'payroll', 'ADMINISTER', 'Manage payroll permissions', 'Grant payroll permissions to others.'),
    ('payroll.manage_settings', 'payroll', 'ADMINISTER', 'Manage payroll settings', 'Payroll policies and components.'),
    ('payroll.import', 'payroll', 'CREATE', 'Import payroll', 'Import variable lines from a spreadsheet.'),
    ('payroll.manage_installments', 'payroll', 'EDIT', 'Manage installments', 'Installment and advance plans.'),
    ('payroll.publish_payslips', 'payroll', 'EXECUTE', 'Publish payslips', 'Publish payslips to employees and withdraw them.'),
    ('payroll.view_audit_log', 'payroll', 'VIEW', 'View payroll log', 'View the payroll action log.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
where r.role_key = 'owner' and p.permission_key like 'payroll.%' and p.permission_key <> 'payroll.view_cost'
on conflict (role_id, permission_id) do nothing;

-- payroll.manage_permissions is the owner's (never delegated, like permissions.assign)
create or replace function public.prosm_time_undelegable_permissions()
returns text[]
language sql
immutable
set search_path = public
as $$
    select array['permissions.assign', 'administrators.manage', 'payroll.manage_permissions', 'payroll.manage_settings'];
$$;
revoke all on function public.prosm_time_undelegable_permissions() from public, anon, authenticated;

-- payroll is a plan feature: Pro (and the organisations from before plans) have it
update public.plans set feature_flags = feature_flags || '{"payroll": true}'::jsonb where key in ('pro', 'legacy');

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists public.payroll_settings (
    organization_id uuid primary key references public.organizations(id) on delete cascade,
    period_start_day smallint not null default 1 check (period_start_day between 1 and 28),
    proration_policy text not null default 'calendar' check (proration_policy in ('none', 'calendar', 'working', 'fixed')),
    proration_divisor numeric(6,2) not null default 30 check (proration_divisor > 0),
    day_divisor numeric(6,2) not null default 30 check (day_divisor > 0),
    hours_per_day numeric(5,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
    overtime_multiplier numeric(5,2) not null default 1.5 check (overtime_multiplier > 0),
    default_currency text not null default 'EGP' check (default_currency ~ '^[A-Z]{3}$'),
    allow_negative_net boolean not null default false,
    net_change_warning_percent numeric(6,2) not null default 25 check (net_change_warning_percent >= 0),
    employee_self_service boolean not null default false,
    auto_lock_on_approve boolean not null default false,
    report_language text not null default 'bilingual' check (report_language in ('ar', 'en', 'bilingual')),
    show_signatures boolean not null default true,
    footer_note text check (footer_note is null or length(footer_note) <= 500),
    tax_notice text not null default 'الضرائب والتأمينات تُدخلها المنشأة وهي المسؤولة عن صحتها.' check (length(tax_notice) <= 500),
    last_export_serial bigint not null default 0,
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now()
);
insert into public.payroll_settings (organization_id) select id from public.organizations on conflict do nothing;

create or replace function public.prosm_time_seed_payroll_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into payroll_settings (organization_id) values (new.id) on conflict do nothing;
    return new;
end;
$$;
revoke all on function public.prosm_time_seed_payroll_settings() from public, anon, authenticated;
drop trigger if exists organizations_seed_payroll_settings on public.organizations;
create trigger organizations_seed_payroll_settings after insert on public.organizations
    for each row execute function public.prosm_time_seed_payroll_settings();

create table if not exists public.payroll_components (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name_ar text not null check (length(trim(name_ar)) between 1 and 80),
    name_en text check (name_en is null or length(trim(name_en)) between 1 and 80),
    category text not null check (category in ('earning', 'deduction', 'installment', 'allowance')),
    source text not null check (source in ('fixed', 'variable')),
    calc_type text not null default 'amount' check (calc_type in ('amount', 'percent')),
    percent numeric(7,3),
    percent_base text check (percent_base in ('basic', 'component', 'earnings')),
    base_component_id uuid references public.payroll_components(id) on delete restrict,
    is_basic boolean not null default false,
    include_in_net boolean not null default true,
    show_in_payslip boolean not null default true,
    show_in_summary boolean not null default true,
    include_in_combined boolean not null default false,
    prorate boolean not null default false,
    sort_order integer not null default 100,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- a line in the net is always visible on the payslip and the summary
    constraint payroll_components_net_visible check (not include_in_net or (show_in_payslip and show_in_summary)),
    -- a line outside the net never appears on the payslip or the summary
    constraint payroll_components_outside_net_hidden check (include_in_net or (not show_in_payslip and not show_in_summary)),
    constraint payroll_components_percent check (
        (calc_type = 'amount' and percent is null and percent_base is null and base_component_id is null)
        or (calc_type = 'percent' and percent > 0 and percent_base is not null
            and (percent_base <> 'component' or base_component_id is not null)
            and (category <> 'deduction' or percent <= 100))),
    constraint payroll_components_not_self check (base_component_id is null or base_component_id <> id),
    constraint payroll_components_basic check (not is_basic or (category = 'earning' and calc_type = 'amount' and include_in_net))
);
create unique index if not exists payroll_components_one_basic on public.payroll_components (organization_id) where is_basic and is_active;
create index if not exists payroll_components_org_idx on public.payroll_components (organization_id);

create table if not exists public.payroll_profiles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null unique references public.users(id) on delete restrict,
    employee_code text check (employee_code is null or length(trim(employee_code)) between 1 and 40),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    start_date date,
    end_date date,
    is_active boolean not null default true,
    notes text check (notes is null or length(notes) <= 500),
    row_version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists payroll_profiles_org_idx on public.payroll_profiles (organization_id);

create table if not exists public.payroll_profile_components (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    profile_id uuid not null references public.payroll_profiles(id) on delete cascade,
    component_id uuid not null references public.payroll_components(id) on delete restrict,
    amount numeric(14,2),
    percent numeric(7,3),
    effective_from date not null,
    effective_to date,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    check (effective_to is null or effective_to >= effective_from),
    check (amount is not null or percent is not null)
);
create index if not exists payroll_profile_components_profile_idx on public.payroll_profile_components (profile_id, component_id, effective_from);
create index if not exists payroll_profile_components_org_idx on public.payroll_profile_components (organization_id);

create table if not exists public.payroll_cycles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete restrict,
    title text not null check (length(trim(title)) between 1 and 120),
    period_start date not null,
    period_end date not null,
    status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'locked', 'reopened', 'cancelled')),
    cycle_version integer not null default 0,
    row_version integer not null default 1,
    policy_snapshot jsonb not null,
    created_by uuid references public.users(id) on delete set null,
    submitted_by uuid references public.users(id) on delete set null,
    submitted_at timestamptz,
    approved_by uuid references public.users(id) on delete set null,
    approved_at timestamptz,
    locked_by uuid references public.users(id) on delete set null,
    locked_at timestamptz,
    reopened_by uuid references public.users(id) on delete set null,
    reopened_at timestamptz,
    reopen_reason text,
    cancelled_by uuid references public.users(id) on delete set null,
    cancelled_at timestamptz,
    cancel_reason text,
    warnings_acknowledged_by uuid references public.users(id) on delete set null,
    published_version integer,
    published_at timestamptz,
    published_by uuid references public.users(id) on delete set null,
    publication_no integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (period_end >= period_start and period_end - period_start <= 62)
);
create index if not exists payroll_cycles_org_period_idx on public.payroll_cycles (organization_id, period_start, period_end);

create table if not exists public.payroll_cycle_employees (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete restrict,
    site_id uuid references public.sites(id) on delete set null,
    full_name text not null,
    employee_code text,
    currency text not null,
    has_profile boolean not null default false,
    proration_factor numeric(9,6) not null default 1,
    days_counted numeric(6,2),
    days_in_period numeric(6,2),
    total_earnings numeric(14,2) not null default 0,
    total_deductions numeric(14,2) not null default 0,
    total_installments numeric(14,2) not null default 0,
    net_salary numeric(14,2) not null default 0,
    base_salary numeric(14,2) not null default 0,
    total_allowances numeric(14,2) not null default 0,
    combined_total numeric(14,2) not null default 0,
    row_version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (cycle_id, user_id)
);
create index if not exists payroll_cycle_employees_org_idx on public.payroll_cycle_employees (organization_id);
create index if not exists payroll_cycle_employees_user_idx on public.payroll_cycle_employees (user_id);

create table if not exists public.payroll_cycle_lines (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    cycle_employee_id uuid not null references public.payroll_cycle_employees(id) on delete cascade,
    component_id uuid references public.payroll_components(id) on delete set null,
    name_ar text not null,
    name_en text,
    category text not null check (category in ('earning', 'deduction', 'installment', 'allowance')),
    source text not null check (source in ('fixed', 'variable', 'installment', 'attendance_suggestion', 'import')),
    calc_type text not null default 'amount' check (calc_type in ('amount', 'percent')),
    percent numeric(7,3),
    percent_base text,
    base_component_id uuid,
    is_basic boolean not null default false,
    raw_amount numeric(14,2) not null default 0,
    base_amount numeric(14,2),
    amount numeric(14,2) not null default 0,
    prorate boolean not null default false,
    include_in_net boolean not null,
    show_in_payslip boolean not null,
    show_in_summary boolean not null,
    include_in_combined boolean not null,
    sort_order integer not null default 100,
    installment_plan_id uuid,
    installment_no integer,
    source_ref jsonb,
    notes text check (notes is null or length(notes) <= 300),
    row_version integer not null default 1,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint payroll_cycle_lines_net_visible check (not include_in_net or (show_in_payslip and show_in_summary)),
    constraint payroll_cycle_lines_outside_net_hidden check (include_in_net or (not show_in_payslip and not show_in_summary)),
    constraint payroll_cycle_lines_amount check (amount >= 0 and raw_amount >= 0)
);
create index if not exists payroll_cycle_lines_employee_idx on public.payroll_cycle_lines (cycle_employee_id);
create index if not exists payroll_cycle_lines_org_idx on public.payroll_cycle_lines (organization_id);

create table if not exists public.payroll_installment_plans (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete restrict,
    name text not null check (length(trim(name)) between 1 and 120),
    total_amount numeric(14,2) not null check (total_amount > 0),
    installments_count integer not null check (installments_count between 1 and 120),
    installment_amount numeric(14,2) not null check (installment_amount > 0),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    start_period date not null,
    status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
    paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),
    row_version integer not null default 1,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (paid_amount <= total_amount)
);
create index if not exists payroll_installment_plans_user_idx on public.payroll_installment_plans (user_id);
create index if not exists payroll_installment_plans_org_idx on public.payroll_installment_plans (organization_id);

create table if not exists public.payroll_installment_payments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    plan_id uuid not null references public.payroll_installment_plans(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    installment_no integer not null,
    amount numeric(14,2) not null check (amount > 0),
    created_at timestamptz not null default now(),
    unique (plan_id, cycle_id)
);
create index if not exists payroll_installment_payments_org_idx on public.payroll_installment_payments (organization_id);

create table if not exists public.payroll_cycle_snapshots (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    cycle_version integer not null,
    data jsonb not null,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (cycle_id, cycle_version)
);
create index if not exists payroll_cycle_snapshots_org_idx on public.payroll_cycle_snapshots (organization_id);

create table if not exists public.payroll_exports (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    serial_no bigint not null,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    cycle_version integer not null,
    report_type text not null check (report_type in ('payslip', 'summary', 'combined')),
    file_format text not null check (file_format in ('pdf', 'xlsx', 'zip', 'preview')),
    employee_count integer not null,
    exported_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (organization_id, serial_no)
);
create index if not exists payroll_exports_cycle_idx on public.payroll_exports (cycle_id);

do $$
declare
    v_table text;
begin
    foreach v_table in array array['payroll_settings', 'payroll_components', 'payroll_profiles', 'payroll_profile_components', 'payroll_cycles',
        'payroll_cycle_employees', 'payroll_cycle_lines', 'payroll_installment_plans', 'payroll_installment_payments', 'payroll_cycle_snapshots', 'payroll_exports'] loop
        execute format('alter table public.%I enable row level security', v_table);
        execute format('revoke all on public.%I from anon, authenticated', v_table);
        -- the action log for every change to settings, components, profiles, plans and cycles
        if v_table in ('payroll_settings', 'payroll_components', 'payroll_profiles', 'payroll_profile_components', 'payroll_installment_plans') then
            execute format('drop trigger if exists %I on public.%I', v_table || '_audit_row_change', v_table);
            execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.prosm_time_audit_row_change()', v_table || '_audit_row_change', v_table);
        end if;
    end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Authority and scope
-- ---------------------------------------------------------------------------------------------
create or replace function public.prosm_time_payroll_allows(p_key text, p_site uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_id() is not null
       and public.prosm_time_plan_allows(public.current_prosm_time_organization_id(), 'payroll')
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
revoke all on function public.prosm_time_payroll_allows(text, uuid) from public, anon, authenticated;

create or replace function public.prosm_time_payroll_require(p_key text, p_site uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('payroll');
    if not public.prosm_time_payroll_allows(p_key, p_site) then
        raise exception 'PAYROLL AUTHORITY REQUIRED: %', p_key;
    end if;
end;
$$;
revoke all on function public.prosm_time_payroll_require(text, uuid) from public, anon, authenticated;

-- A cycle of the caller's organisation, locked for update when asked.
create or replace function public.prosm_time_payroll_cycle(p_cycle_id uuid)
returns public.payroll_cycles
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype;
begin
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null then raise exception 'PAYROLL CYCLE NOT FOUND'; end if;
    return v_cycle;
end;
$$;
revoke all on function public.prosm_time_payroll_cycle(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_payroll_require_editable(p_cycle payroll_cycles)
returns void
language plpgsql
immutable
as $$
begin
    if p_cycle.status not in ('draft', 'reopened') then
        raise exception 'THIS PAYROLL CYCLE CANNOT BE CHANGED IN STATUS %', upper(p_cycle.status);
    end if;
end;
$$;
revoke all on function public.prosm_time_payroll_require_editable(payroll_cycles) from public, anon, authenticated;

create or replace function public.prosm_time_payroll_log(p_org uuid, p_action text, p_entity text, p_entity_id uuid, p_subject uuid, p_description text, p_reason text, p_context jsonb)
returns void
language sql
security definer
set search_path = public
as $$
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (p_org, public.current_prosm_time_user_id(), p_subject, p_action, p_entity, p_entity_id, p_description, p_reason, coalesce(p_context, '{}'::jsonb));
$$;
revoke all on function public.prosm_time_payroll_log(uuid, text, text, uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Settings and components
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_prosm_time_payroll_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_settings payroll_settings%rowtype;
begin
    perform public.prosm_time_payroll_require('payroll.access', null::uuid)
        where not public.prosm_time_payroll_allows('payroll.manage_settings', null);
    select * into v_settings from payroll_settings where organization_id = public.current_prosm_time_organization_id();
    return to_jsonb(v_settings) - 'organization_id' - 'last_export_serial';
end;
$$;
revoke all on function public.get_prosm_time_payroll_settings() from public, anon;
grant execute on function public.get_prosm_time_payroll_settings() to authenticated;

create or replace function public.save_prosm_time_payroll_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    perform public.prosm_time_payroll_require('payroll.manage_settings', null);
    if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'INVALID SETTINGS'; end if;
    update payroll_settings set
        period_start_day = coalesce((p_settings ->> 'period_start_day')::smallint, period_start_day),
        proration_policy = coalesce(p_settings ->> 'proration_policy', proration_policy),
        proration_divisor = coalesce((p_settings ->> 'proration_divisor')::numeric, proration_divisor),
        day_divisor = coalesce((p_settings ->> 'day_divisor')::numeric, day_divisor),
        hours_per_day = coalesce((p_settings ->> 'hours_per_day')::numeric, hours_per_day),
        overtime_multiplier = coalesce((p_settings ->> 'overtime_multiplier')::numeric, overtime_multiplier),
        default_currency = coalesce(upper(p_settings ->> 'default_currency'), default_currency),
        allow_negative_net = coalesce((p_settings ->> 'allow_negative_net')::boolean, allow_negative_net),
        net_change_warning_percent = coalesce((p_settings ->> 'net_change_warning_percent')::numeric, net_change_warning_percent),
        employee_self_service = coalesce((p_settings ->> 'employee_self_service')::boolean, employee_self_service),
        auto_lock_on_approve = coalesce((p_settings ->> 'auto_lock_on_approve')::boolean, auto_lock_on_approve),
        report_language = coalesce(p_settings ->> 'report_language', report_language),
        show_signatures = coalesce((p_settings ->> 'show_signatures')::boolean, show_signatures),
        footer_note = case when p_settings ? 'footer_note' then nullif(trim(p_settings ->> 'footer_note'), '') else footer_note end,
        tax_notice = coalesce(nullif(trim(p_settings ->> 'tax_notice'), ''), tax_notice),
        updated_by = public.current_prosm_time_user_id(),
        updated_at = now()
    where organization_id = v_org;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.save_prosm_time_payroll_settings(jsonb) from public, anon;
grant execute on function public.save_prosm_time_payroll_settings(jsonb) to authenticated;

create or replace function public.list_prosm_time_payroll_components()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    perform public.prosm_time_payroll_require('payroll.access', null::uuid)
        where not public.prosm_time_payroll_allows('payroll.manage_settings', null);
    return coalesce((
        select jsonb_agg(to_jsonb(c) - 'organization_id' order by c.sort_order, c.name_ar)
        from payroll_components c where c.organization_id = public.current_prosm_time_organization_id()
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_payroll_components() from public, anon;
grant execute on function public.list_prosm_time_payroll_components() to authenticated;

create or replace function public.save_prosm_time_payroll_component(p_id uuid, p_component jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
    v_base uuid := nullif(p_component ->> 'base_component_id', '')::uuid;
    v_category text := p_component ->> 'category';
    v_in_net boolean := coalesce((p_component ->> 'include_in_net')::boolean, true);
begin
    perform public.prosm_time_payroll_require('payroll.manage_settings', null);
    if v_base is not null then
        if not exists (select 1 from payroll_components where id = v_base and organization_id = v_org and calc_type = 'amount') then
            -- a percentage is taken from an amount component of the same organisation (no circular bases)
            raise exception 'THE BASE MUST BE AN AMOUNT COMPONENT';
        end if;
    end if;
    if p_id is null then
        insert into payroll_components (organization_id, name_ar, name_en, category, source, calc_type, percent, percent_base, base_component_id,
                                        is_basic, include_in_net, show_in_payslip, show_in_summary, include_in_combined, prorate, sort_order, is_active)
        values (v_org, trim(p_component ->> 'name_ar'), nullif(trim(coalesce(p_component ->> 'name_en', '')), ''), v_category,
                coalesce(p_component ->> 'source', 'variable'), coalesce(p_component ->> 'calc_type', 'amount'),
                (p_component ->> 'percent')::numeric, nullif(p_component ->> 'percent_base', ''), v_base,
                coalesce((p_component ->> 'is_basic')::boolean, false), v_in_net,
                v_in_net, v_in_net,
                coalesce((p_component ->> 'include_in_combined')::boolean, v_category = 'allowance'),
                coalesce((p_component ->> 'prorate')::boolean, false), coalesce((p_component ->> 'sort_order')::integer, 100),
                coalesce((p_component ->> 'is_active')::boolean, true))
        returning id into v_id;
    else
        update payroll_components set
            name_ar = coalesce(trim(p_component ->> 'name_ar'), name_ar),
            name_en = case when p_component ? 'name_en' then nullif(trim(coalesce(p_component ->> 'name_en', '')), '') else name_en end,
            category = coalesce(v_category, category),
            source = coalesce(p_component ->> 'source', source),
            calc_type = coalesce(p_component ->> 'calc_type', calc_type),
            percent = case when p_component ? 'percent' then (p_component ->> 'percent')::numeric else percent end,
            percent_base = case when p_component ? 'percent_base' then nullif(p_component ->> 'percent_base', '') else percent_base end,
            base_component_id = case when p_component ? 'base_component_id' then v_base else base_component_id end,
            is_basic = coalesce((p_component ->> 'is_basic')::boolean, is_basic),
            include_in_net = coalesce((p_component ->> 'include_in_net')::boolean, include_in_net),
            show_in_payslip = coalesce((p_component ->> 'include_in_net')::boolean, include_in_net),
            show_in_summary = coalesce((p_component ->> 'include_in_net')::boolean, include_in_net),
            include_in_combined = coalesce((p_component ->> 'include_in_combined')::boolean, include_in_combined),
            prorate = coalesce((p_component ->> 'prorate')::boolean, prorate),
            sort_order = coalesce((p_component ->> 'sort_order')::integer, sort_order),
            is_active = coalesce((p_component ->> 'is_active')::boolean, is_active),
            updated_at = now()
        where id = p_id and organization_id = v_org
        returning id into v_id;
        if v_id is null then raise exception 'COMPONENT NOT FOUND'; end if;
    end if;
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_payroll_component(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_payroll_component(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Profiles (fixed components with effective dates)
-- ---------------------------------------------------------------------------------------------
create or replace function public.save_prosm_time_payroll_profile(p_user_id uuid, p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_user users%rowtype;
    v_id uuid;
    v_currency text;
begin
    select * into v_user from users where id = p_user_id and organization_id = v_org;
    if v_user.id is null then raise exception 'USER NOT FOUND'; end if;
    perform public.prosm_time_payroll_require('payroll.manage_profiles', public.prosm_time_calendar_site(p_user_id));
    v_currency := upper(coalesce(nullif(p_profile ->> 'currency', ''), (select default_currency from payroll_settings where organization_id = v_org)));
    insert into payroll_profiles (organization_id, user_id, employee_code, currency, start_date, end_date, is_active, notes)
    values (v_org, p_user_id, nullif(trim(coalesce(p_profile ->> 'employee_code', '')), ''), v_currency,
            nullif(p_profile ->> 'start_date', '')::date, nullif(p_profile ->> 'end_date', '')::date,
            coalesce((p_profile ->> 'is_active')::boolean, true), nullif(trim(coalesce(p_profile ->> 'notes', '')), ''))
    on conflict (user_id) do update set
        employee_code = case when p_profile ? 'employee_code' then excluded.employee_code else payroll_profiles.employee_code end,
        currency = excluded.currency,
        start_date = case when p_profile ? 'start_date' then excluded.start_date else payroll_profiles.start_date end,
        end_date = case when p_profile ? 'end_date' then excluded.end_date else payroll_profiles.end_date end,
        is_active = excluded.is_active,
        notes = case when p_profile ? 'notes' then excluded.notes else payroll_profiles.notes end,
        row_version = payroll_profiles.row_version + 1,
        updated_at = now()
    returning id into v_id;
    return jsonb_build_object('success', true, 'profileId', v_id);
end;
$$;
revoke all on function public.save_prosm_time_payroll_profile(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_payroll_profile(uuid, jsonb) to authenticated;

-- A new value from a date; the previous one ends the day before (history is never rewritten).
create or replace function public.set_prosm_time_payroll_profile_component(p_user_id uuid, p_component_id uuid, p_amount numeric, p_percent numeric, p_effective_from date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_profile payroll_profiles%rowtype;
    v_component payroll_components%rowtype;
    v_id uuid;
begin
    perform public.prosm_time_payroll_require('payroll.manage_profiles', public.prosm_time_calendar_site(p_user_id));
    select * into v_profile from payroll_profiles where user_id = p_user_id and organization_id = v_org;
    if v_profile.id is null then raise exception 'CREATE THE PAYROLL PROFILE FIRST'; end if;
    select * into v_component from payroll_components where id = p_component_id and organization_id = v_org and is_active;
    if v_component.id is null then raise exception 'COMPONENT NOT FOUND'; end if;
    if v_component.source <> 'fixed' then raise exception 'ONLY FIXED COMPONENTS BELONG ON THE PROFILE'; end if;
    if p_effective_from is null then raise exception 'THE EFFECTIVE DATE IS REQUIRED'; end if;
    if v_component.calc_type = 'amount' and (p_amount is null or p_amount < 0) then raise exception 'INVALID AMOUNT'; end if;
    if exists (select 1 from payroll_profile_components where profile_id = v_profile.id and component_id = p_component_id and effective_from >= p_effective_from) then
        -- replacing a value from the same or a later date: the future value is replaced
        delete from payroll_profile_components where profile_id = v_profile.id and component_id = p_component_id and effective_from >= p_effective_from;
    end if;
    update payroll_profile_components set effective_to = p_effective_from - 1
    where profile_id = v_profile.id and component_id = p_component_id and (effective_to is null or effective_to >= p_effective_from);
    if p_amount is null and p_percent is null then
        -- ending the component from this date
        return jsonb_build_object('success', true, 'ended', true);
    end if;
    insert into payroll_profile_components (organization_id, profile_id, component_id, amount, percent, effective_from, created_by)
    values (v_org, v_profile.id, p_component_id, case when v_component.calc_type = 'amount' then round(p_amount, 2) end,
            case when v_component.calc_type = 'percent' then coalesce(p_percent, v_component.percent) end, p_effective_from, public.current_prosm_time_user_id())
    returning id into v_id;
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.set_prosm_time_payroll_profile_component(uuid, uuid, numeric, numeric, date) from public, anon;
grant execute on function public.set_prosm_time_payroll_profile_component(uuid, uuid, numeric, numeric, date) to authenticated;

create or replace function public.list_prosm_time_payroll_profiles()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    perform public.prosm_time_require_feature('payroll');
    if not (public.prosm_time_payroll_allows('payroll.manage_profiles', null) or public.prosm_time_payroll_allows('payroll.view', null)
            or exists (select 1 from users u where u.organization_id = v_org and (public.prosm_time_payroll_allows('payroll.manage_profiles', public.prosm_time_calendar_site(u.id)) or public.prosm_time_payroll_allows('payroll.view', public.prosm_time_calendar_site(u.id))))) then
        raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.view';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'userId', u.id, 'fullName', u.full_name, 'isActive', u.is_active, 'siteId', s.site_id,
            'siteName', (select name from sites where id = s.site_id),
            'profile', case when p.id is null then null else to_jsonb(p) - 'organization_id' end,
            'components', coalesce((
                select jsonb_agg(jsonb_build_object('id', pc.id, 'componentId', pc.component_id, 'nameAr', c.name_ar, 'nameEn', c.name_en, 'category', c.category,
                                                    'calcType', c.calc_type, 'amount', pc.amount, 'percent', pc.percent,
                                                    'effectiveFrom', pc.effective_from, 'effectiveTo', pc.effective_to) order by c.sort_order, pc.effective_from)
                from payroll_profile_components pc join payroll_components c on c.id = pc.component_id
                where pc.profile_id = p.id and (pc.effective_to is null or pc.effective_to >= current_date)
            ), '[]'::jsonb)) order by u.full_name)
        from users u
        cross join lateral (select public.prosm_time_calendar_site(u.id) as site_id) s
        left join payroll_profiles p on p.user_id = u.id
        where u.organization_id = v_org and not u.is_owner
          and (public.prosm_time_payroll_allows('payroll.manage_profiles', s.site_id) or public.prosm_time_payroll_allows('payroll.view', s.site_id))
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_payroll_profiles() from public, anon;
grant execute on function public.list_prosm_time_payroll_profiles() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Installment plans
-- ---------------------------------------------------------------------------------------------
create or replace function public.save_prosm_time_installment_plan(p_user_id uuid, p_name text, p_total numeric, p_count integer, p_start_period date, p_installment numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_currency text;
    v_id uuid;
begin
    perform public.prosm_time_payroll_require('payroll.manage_installments', public.prosm_time_calendar_site(p_user_id));
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then raise exception 'USER NOT FOUND'; end if;
    select currency into v_currency from payroll_profiles where user_id = p_user_id and organization_id = v_org;
    if v_currency is null then raise exception 'CREATE THE PAYROLL PROFILE FIRST'; end if;
    if p_total is null or p_total <= 0 or p_count is null or p_count < 1 then raise exception 'INVALID INSTALLMENT PLAN'; end if;
    insert into payroll_installment_plans (organization_id, user_id, name, total_amount, installments_count, installment_amount, currency, start_period, created_by)
    values (v_org, p_user_id, trim(p_name), round(p_total, 2), p_count, round(coalesce(p_installment, p_total / p_count), 2), v_currency,
            coalesce(p_start_period, current_date), public.current_prosm_time_user_id())
    returning id into v_id;
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_installment_plan(uuid, text, numeric, integer, date, numeric) from public, anon;
grant execute on function public.save_prosm_time_installment_plan(uuid, text, numeric, integer, date, numeric) to authenticated;

-- Reschedule (new installment amount or start) or settle/cancel, with a reason.
create or replace function public.change_prosm_time_installment_plan(p_plan_id uuid, p_action text, p_reason text, p_installment numeric default null, p_start_period date default null, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_plan payroll_installment_plans%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    select * into v_plan from payroll_installment_plans where id = p_plan_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_plan.id is null then raise exception 'INSTALLMENT PLAN NOT FOUND'; end if;
    perform public.prosm_time_payroll_require('payroll.manage_installments', public.prosm_time_calendar_site(v_plan.user_id));
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    if p_expected_version is not null and p_expected_version <> v_plan.row_version then raise exception 'THIS PLAN WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    if v_plan.status <> 'active' then raise exception 'THIS PLAN IS NOT ACTIVE'; end if;
    if p_action = 'reschedule' then
        update payroll_installment_plans set installment_amount = coalesce(round(p_installment, 2), installment_amount),
            start_period = coalesce(p_start_period, start_period), row_version = row_version + 1, updated_at = now()
        where id = p_plan_id;
    elsif p_action = 'settle' then
        update payroll_installment_plans set status = 'completed', row_version = row_version + 1, updated_at = now() where id = p_plan_id;
    elsif p_action = 'cancel' then
        update payroll_installment_plans set status = 'cancelled', row_version = row_version + 1, updated_at = now() where id = p_plan_id;
    else
        raise exception 'INVALID ACTION';
    end if;
    perform public.prosm_time_payroll_log(v_plan.organization_id, 'payroll.installment_' || p_action, 'payroll_installment_plans', p_plan_id, v_plan.user_id,
                                          'Installment plan ' || p_action, v_reason, '{}'::jsonb);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.change_prosm_time_installment_plan(uuid, text, text, numeric, date, integer) from public, anon;
grant execute on function public.change_prosm_time_installment_plan(uuid, text, text, numeric, date, integer) to authenticated;

create or replace function public.list_prosm_time_installment_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    perform public.prosm_time_require_feature('payroll');
    return coalesce((
        select jsonb_agg(to_jsonb(p) - 'organization_id' || jsonb_build_object('fullName', u.full_name,
                         'remaining', p.total_amount - p.paid_amount,
                         'paidCount', (select count(*) from payroll_installment_payments x where x.plan_id = p.id)) order by p.created_at desc)
        from payroll_installment_plans p join users u on u.id = p.user_id
        where p.organization_id = public.current_prosm_time_organization_id()
          and (public.prosm_time_payroll_allows('payroll.manage_installments', public.prosm_time_calendar_site(p.user_id))
               or public.prosm_time_payroll_allows('payroll.view', public.prosm_time_calendar_site(p.user_id)))
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_installment_plans() from public, anon;
grant execute on function public.list_prosm_time_installment_plans() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Calculation
-- ---------------------------------------------------------------------------------------------
create or replace function public.prosm_time_payroll_recalc_employee(p_cycle_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_factor numeric;
    v_basic numeric;
    v_earnings_base numeric;
    v_line record;
    v_base numeric;
begin
    select proration_factor into v_factor from payroll_cycle_employees where id = p_cycle_employee_id;
    -- 1. amount lines (prorated when the component says so)
    update payroll_cycle_lines set amount = round(raw_amount * case when prorate then v_factor else 1 end, 2), base_amount = null
    where cycle_employee_id = p_cycle_employee_id and calc_type = 'amount';
    select coalesce(sum(amount), 0) into v_basic from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and is_basic;
    select coalesce(sum(amount), 0) into v_earnings_base from payroll_cycle_lines
    where cycle_employee_id = p_cycle_employee_id and calc_type = 'amount' and category in ('earning', 'allowance') and include_in_net;
    -- 2. percentage lines, from the basic salary, a component's amount, or the total earnings
    for v_line in select * from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id and calc_type = 'percent' loop
        v_base := case v_line.percent_base
            when 'basic' then v_basic
            when 'earnings' then v_earnings_base
            when 'component' then coalesce((select sum(amount) from payroll_cycle_lines b
                                            where b.cycle_employee_id = p_cycle_employee_id and b.component_id = v_line.base_component_id and b.calc_type = 'amount'), 0)
            else 0 end;
        update payroll_cycle_lines set base_amount = round(v_base, 2), amount = round(v_base * v_line.percent / 100, 2), updated_at = now()
        where id = v_line.id;
    end loop;
    -- 3. totals
    update payroll_cycle_employees e set
        total_earnings = t.earnings,
        total_deductions = t.deductions,
        total_installments = t.installments,
        net_salary = t.earnings - t.deductions - t.installments,
        base_salary = t.basic,
        total_allowances = t.allowances,
        combined_total = t.basic + t.allowances,
        updated_at = now()
    from (
        select coalesce(sum(amount) filter (where category in ('earning', 'allowance') and include_in_net), 0) as earnings,
               coalesce(sum(amount) filter (where category = 'deduction' and include_in_net), 0) as deductions,
               coalesce(sum(amount) filter (where category = 'installment' and include_in_net), 0) as installments,
               coalesce(sum(amount) filter (where is_basic), 0) as basic,
               coalesce(sum(amount) filter (where category = 'allowance' and include_in_combined), 0) as allowances
        from payroll_cycle_lines where cycle_employee_id = p_cycle_employee_id
    ) t
    where e.id = p_cycle_employee_id;
end;
$$;
revoke all on function public.prosm_time_payroll_recalc_employee(uuid) from public, anon, authenticated;

-- Proration factor for one employee in a period, from the cycle's policy snapshot.
create or replace function public.prosm_time_payroll_proration(p_policy jsonb, p_user uuid, p_start date, p_end date, p_from date, p_to date)
returns table (factor numeric, counted numeric, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_from date := greatest(p_start, coalesce(p_from, p_start));
    v_to date := least(p_end, coalesce(p_to, p_end));
    v_policy text := coalesce(p_policy ->> 'proration_policy', 'calendar');
    v_total numeric;
    v_counted numeric;
begin
    if v_to < v_from then
        factor := 0; counted := 0; total := (p_end - p_start) + 1; return next; return;
    end if;
    if v_policy = 'none' or (v_from = p_start and v_to = p_end) then
        factor := 1; counted := (p_end - p_start) + 1; total := counted; return next; return;
    end if;
    if v_policy = 'working' then
        v_total := cardinality(public.prosm_time_leave_working_dates(p_user, p_start, p_end));
        v_counted := cardinality(public.prosm_time_leave_working_dates(p_user, v_from, v_to));
    elsif v_policy = 'fixed' then
        v_total := coalesce((p_policy ->> 'proration_divisor')::numeric, 30);
        v_counted := least((v_to - v_from) + 1, v_total);
    else
        v_total := (p_end - p_start) + 1;
        v_counted := (v_to - v_from) + 1;
    end if;
    factor := case when v_total > 0 then least(round(v_counted / v_total, 6), 1) else 1 end;
    counted := v_counted;
    total := v_total;
    return next;
end;
$$;
revoke all on function public.prosm_time_payroll_proration(jsonb, uuid, date, date, date, date) from public, anon, authenticated;

-- (Re)build one employee's fixed and installment lines from the profile, keeping variable lines.
create or replace function public.prosm_time_payroll_build_employee(p_cycle_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ce payroll_cycle_employees%rowtype;
    v_cycle payroll_cycles%rowtype;
    v_profile payroll_profiles%rowtype;
    v_pr record;
    v_plan record;
    v_due numeric;
begin
    select * into v_ce from payroll_cycle_employees where id = p_cycle_employee_id;
    select * into v_cycle from payroll_cycles where id = v_ce.cycle_id;
    select * into v_profile from payroll_profiles where user_id = v_ce.user_id and organization_id = v_ce.organization_id;
    delete from payroll_cycle_lines where cycle_employee_id = v_ce.id and source in ('fixed', 'installment');

    select * into v_pr from public.prosm_time_payroll_proration(v_cycle.policy_snapshot, v_ce.user_id, v_cycle.period_start, v_cycle.period_end,
                                                                v_profile.start_date, v_profile.end_date);
    update payroll_cycle_employees set
        has_profile = v_profile.id is not null and v_profile.is_active,
        currency = coalesce(v_profile.currency, v_cycle.policy_snapshot ->> 'default_currency', 'EGP'),
        employee_code = v_profile.employee_code,
        proration_factor = coalesce(v_pr.factor, 1), days_counted = v_pr.counted, days_in_period = v_pr.total, updated_at = now()
    where id = v_ce.id;

    if v_profile.id is null or not v_profile.is_active then
        perform public.prosm_time_payroll_recalc_employee(v_ce.id);
        return;
    end if;

    -- the value effective on the last day of the period (or the last one inside the period)
    insert into payroll_cycle_lines (organization_id, cycle_employee_id, component_id, name_ar, name_en, category, source, calc_type, percent, percent_base,
                                     base_component_id, is_basic, raw_amount, prorate, include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order)
    select v_ce.organization_id, v_ce.id, c.id, c.name_ar, c.name_en, c.category, 'fixed', c.calc_type, coalesce(pc.percent, c.percent), c.percent_base,
           c.base_component_id, c.is_basic, coalesce(pc.amount, 0), c.prorate, c.include_in_net, c.show_in_payslip, c.show_in_summary, c.include_in_combined, c.sort_order
    from payroll_components c
    join lateral (
        select x.* from payroll_profile_components x
        where x.profile_id = v_profile.id and x.component_id = c.id
          and x.effective_from <= v_cycle.period_end and (x.effective_to is null or x.effective_to >= v_cycle.period_start)
        order by x.effective_from desc limit 1
    ) pc on true
    where c.organization_id = v_ce.organization_id and c.is_active and c.source = 'fixed';

    -- installments due in this period ("installment 3 of 10"), never beyond the remaining balance
    for v_plan in
        select p.*, (select count(*) from payroll_installment_payments x where x.plan_id = p.id and x.cycle_id <> v_cycle.id) as paid_count,
               (select coalesce(sum(x.amount), 0) from payroll_installment_payments x where x.plan_id = p.id and x.cycle_id <> v_cycle.id) as paid_sum
        from payroll_installment_plans p
        where p.user_id = v_ce.user_id and p.status = 'active' and p.start_period <= v_cycle.period_end
    loop
        v_due := least(v_plan.installment_amount, v_plan.total_amount - v_plan.paid_sum);
        if v_due > 0 then
            insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, raw_amount, include_in_net,
                                             show_in_payslip, show_in_summary, include_in_combined, sort_order, installment_plan_id, installment_no)
            values (v_ce.organization_id, v_ce.id,
                    v_plan.name || ' - قسط ' || (v_plan.paid_count + 1) || ' من ' || v_plan.installments_count,
                    v_plan.name || ' - installment ' || (v_plan.paid_count + 1) || ' of ' || v_plan.installments_count,
                    'installment', 'installment', v_due, true, true, true, false, 900, v_plan.id, v_plan.paid_count + 1);
        end if;
    end loop;

    perform public.prosm_time_payroll_recalc_employee(v_ce.id);
end;
$$;
revoke all on function public.prosm_time_payroll_build_employee(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Cycles
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_prosm_time_payroll_cycle(p_period_start date, p_period_end date, p_site_id uuid default null, p_title text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_settings payroll_settings%rowtype;
    v_cycle_id uuid;
    v_user record;
    v_ce uuid;
    v_count integer := 0;
    v_skipped jsonb := '[]'::jsonb;
begin
    perform public.prosm_time_payroll_require('payroll.edit_draft', p_site_id);
    if p_period_start is null or p_period_end is null or p_period_end < p_period_start then raise exception 'INVALID PERIOD'; end if;
    if p_period_end - p_period_start > 62 then raise exception 'THE PERIOD IS TOO LONG'; end if;
    if p_site_id is not null and not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;
    -- one active cycle per scope and period; an organisation-wide cycle and a site cycle may not overlap
    if exists (
        select 1 from payroll_cycles c where c.organization_id = v_org and c.status <> 'cancelled'
          and c.period_start <= p_period_end and c.period_end >= p_period_start
          and (c.site_id is null or p_site_id is null or c.site_id = p_site_id)
    ) then
        raise exception 'AN ACTIVE PAYROLL CYCLE ALREADY COVERS THIS PERIOD AND SCOPE';
    end if;
    select * into v_settings from payroll_settings where organization_id = v_org;

    insert into payroll_cycles (organization_id, site_id, title, period_start, period_end, policy_snapshot, created_by)
    values (v_org, p_site_id,
            coalesce(nullif(trim(coalesce(p_title, '')), ''), to_char(p_period_start, 'YYYY-MM-DD') || ' - ' || to_char(p_period_end, 'YYYY-MM-DD')),
            p_period_start, p_period_end, to_jsonb(v_settings) - 'organization_id' - 'last_export_serial' - 'updated_by' - 'updated_at',
            public.current_prosm_time_user_id())
    returning id into v_cycle_id;

    -- the people in scope: active, not the owner, in the site at the end of the period
    -- (a person is counted in one cycle per period - never twice across sites)
    for v_user in
        select u.id, u.full_name, public.prosm_time_calendar_site(u.id) as site_id
        from users u
        where u.organization_id = v_org and not u.is_owner
          and (u.is_active or exists (select 1 from payroll_profiles p where p.user_id = u.id and p.end_date between p_period_start and p_period_end))
    loop
        if p_site_id is not null and v_user.site_id is distinct from p_site_id then continue; end if;
        -- only people with an active payroll profile are paid through payroll
        if not exists (select 1 from payroll_profiles p where p.user_id = v_user.id and p.is_active) then
            v_skipped := v_skipped || jsonb_build_object('userId', v_user.id, 'fullName', v_user.full_name, 'reason', 'NO_PROFILE');
            continue;
        end if;
        if exists (
            select 1 from payroll_cycle_employees ce join payroll_cycles c on c.id = ce.cycle_id
            where ce.user_id = v_user.id and c.status <> 'cancelled' and c.id <> v_cycle_id
              and c.period_start <= p_period_end and c.period_end >= p_period_start
        ) then
            v_skipped := v_skipped || jsonb_build_object('userId', v_user.id, 'fullName', v_user.full_name, 'reason', 'IN_ANOTHER_CYCLE');
            continue;
        end if;
        insert into payroll_cycle_employees (organization_id, cycle_id, user_id, site_id, full_name, currency)
        values (v_org, v_cycle_id, v_user.id, v_user.site_id, v_user.full_name, v_settings.default_currency)
        returning id into v_ce;
        perform public.prosm_time_payroll_build_employee(v_ce);
        v_count := v_count + 1;
    end loop;

    perform public.prosm_time_payroll_log(v_org, 'payroll.cycle_created', 'payroll_cycles', v_cycle_id, null,
                                          'Payroll cycle created for ' || p_period_start || ' - ' || p_period_end, null,
                                          jsonb_build_object('employees', v_count, 'skipped', v_skipped, 'siteId', p_site_id));
    return jsonb_build_object('success', true, 'cycleId', v_cycle_id, 'employees', v_count, 'skipped', v_skipped);
end;
$$;
revoke all on function public.create_prosm_time_payroll_cycle(date, date, uuid, text) from public, anon;
grant execute on function public.create_prosm_time_payroll_cycle(date, date, uuid, text) to authenticated;

-- Rebuild the fixed and installment lines from the profiles (draft/reopened only).
create or replace function public.recalculate_prosm_time_payroll_cycle(p_cycle_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
    v_ce record;
begin
    perform public.prosm_time_payroll_require('payroll.edit_draft', v_cycle.site_id);
    perform 1 from payroll_cycles where id = p_cycle_id for update;
    select * into v_cycle from payroll_cycles where id = p_cycle_id;
    perform public.prosm_time_payroll_require_editable(v_cycle);
    if p_expected_version is not null and p_expected_version <> v_cycle.row_version then raise exception 'THIS CYCLE WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    for v_ce in select id from payroll_cycle_employees where cycle_id = p_cycle_id loop
        perform public.prosm_time_payroll_build_employee(v_ce.id);
    end loop;
    update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = p_cycle_id;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.recalculate_prosm_time_payroll_cycle(uuid, integer) from public, anon;
grant execute on function public.recalculate_prosm_time_payroll_cycle(uuid, integer) to authenticated;

-- Variable lines -------------------------------------------------------------------------------
create or replace function public.save_prosm_time_payroll_line(p_cycle_employee_id uuid, p_line_id uuid, p_component_id uuid, p_amount numeric, p_notes text default null,
                                                                p_expected_version integer default null, p_source text default 'variable', p_source_ref jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ce payroll_cycle_employees%rowtype;
    v_cycle payroll_cycles%rowtype;
    v_component payroll_components%rowtype;
    v_line payroll_cycle_lines%rowtype;
    v_id uuid;
begin
    select * into v_ce from payroll_cycle_employees where id = p_cycle_employee_id and organization_id = public.current_prosm_time_organization_id();
    if v_ce.id is null then raise exception 'EMPLOYEE NOT IN THIS CYCLE'; end if;
    perform public.prosm_time_payroll_require(case when p_source = 'import' then 'payroll.import' else 'payroll.enter_monthly_variables' end, v_ce.site_id);
    select * into v_cycle from payroll_cycles where id = v_ce.cycle_id for update;
    perform public.prosm_time_payroll_require_editable(v_cycle);
    if p_source not in ('variable', 'attendance_suggestion', 'import') then raise exception 'INVALID SOURCE'; end if;
    if p_amount is null or p_amount < 0 then raise exception 'INVALID AMOUNT'; end if;
    if p_line_id is not null then
        select * into v_line from payroll_cycle_lines where id = p_line_id and cycle_employee_id = v_ce.id for update;
        if v_line.id is null then raise exception 'LINE NOT FOUND'; end if;
        if v_line.source in ('fixed', 'installment') then raise exception 'FIXED AND INSTALLMENT LINES COME FROM THE PROFILE AND THE PLANS'; end if;
        if p_expected_version is not null and p_expected_version <> v_line.row_version then raise exception 'THIS LINE WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
        update payroll_cycle_lines set raw_amount = round(p_amount, 2), notes = nullif(trim(coalesce(p_notes, '')), ''),
            row_version = row_version + 1, updated_at = now()
        where id = p_line_id
        returning id into v_id;
    else
        select * into v_component from payroll_components where id = p_component_id and organization_id = v_ce.organization_id and is_active;
        if v_component.id is null then raise exception 'COMPONENT NOT FOUND'; end if;
        if v_component.source <> 'variable' then raise exception 'ONLY VARIABLE COMPONENTS ARE ENTERED IN THE CYCLE'; end if;
        if v_component.calc_type <> 'amount' then raise exception 'A PERCENTAGE COMPONENT IS CALCULATED, NOT ENTERED'; end if;
        insert into payroll_cycle_lines (organization_id, cycle_employee_id, component_id, name_ar, name_en, category, source, raw_amount, prorate,
                                         include_in_net, show_in_payslip, show_in_summary, include_in_combined, sort_order, source_ref, notes, created_by)
        values (v_ce.organization_id, v_ce.id, v_component.id, v_component.name_ar, v_component.name_en, v_component.category, p_source, round(p_amount, 2),
                false, v_component.include_in_net, v_component.show_in_payslip, v_component.show_in_summary, v_component.include_in_combined,
                v_component.sort_order, p_source_ref, nullif(trim(coalesce(p_notes, '')), ''), public.current_prosm_time_user_id())
        returning id into v_id;
    end if;
    perform public.prosm_time_payroll_recalc_employee(v_ce.id);
    update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = v_cycle.id;
    perform public.prosm_time_payroll_log(v_ce.organization_id, 'payroll.line_saved', 'payroll_cycle_lines', v_id, v_ce.user_id, 'Payroll line saved', null,
                                          jsonb_build_object('cycleId', v_cycle.id, 'source', p_source));
    return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_payroll_line(uuid, uuid, uuid, numeric, text, integer, text, jsonb) from public, anon;
grant execute on function public.save_prosm_time_payroll_line(uuid, uuid, uuid, numeric, text, integer, text, jsonb) to authenticated;

create or replace function public.delete_prosm_time_payroll_line(p_line_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_line payroll_cycle_lines%rowtype;
    v_ce payroll_cycle_employees%rowtype;
    v_cycle payroll_cycles%rowtype;
begin
    select * into v_line from payroll_cycle_lines where id = p_line_id and organization_id = public.current_prosm_time_organization_id();
    if v_line.id is null then raise exception 'LINE NOT FOUND'; end if;
    select * into v_ce from payroll_cycle_employees where id = v_line.cycle_employee_id;
    perform public.prosm_time_payroll_require('payroll.enter_monthly_variables', v_ce.site_id);
    select * into v_cycle from payroll_cycles where id = v_ce.cycle_id for update;
    perform public.prosm_time_payroll_require_editable(v_cycle);
    if v_line.source in ('fixed', 'installment') then raise exception 'FIXED AND INSTALLMENT LINES COME FROM THE PROFILE AND THE PLANS'; end if;
    if p_expected_version is not null and p_expected_version <> v_line.row_version then raise exception 'THIS LINE WAS CHANGED BY SOMEONE ELSE - RELOAD'; end if;
    delete from payroll_cycle_lines where id = p_line_id;
    perform public.prosm_time_payroll_recalc_employee(v_ce.id);
    update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = v_cycle.id;
    perform public.prosm_time_payroll_log(v_ce.organization_id, 'payroll.line_deleted', 'payroll_cycle_lines', p_line_id, v_ce.user_id, 'Payroll line deleted', null,
                                          jsonb_build_object('cycleId', v_cycle.id, 'previous', to_jsonb(v_line) - 'organization_id'));
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.delete_prosm_time_payroll_line(uuid, integer) from public, anon;
grant execute on function public.delete_prosm_time_payroll_line(uuid, integer) to authenticated;

-- Attendance suggestions (never applied silently) ----------------------------------------------
create or replace function public.list_prosm_time_payroll_suggestions(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype;
begin
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null then raise exception 'PAYROLL CYCLE NOT FOUND'; end if;
    perform public.prosm_time_require_feature('payroll');
    return coalesce((
        select jsonb_agg(s order by s ->> 'fullName', s ->> 'kind')
        from (
            select jsonb_build_object(
                'cycleEmployeeId', ce.id, 'userId', ce.user_id, 'fullName', ce.full_name, 'currency', ce.currency, 'kind', k.kind,
                'quantity', k.quantity, 'unit', k.unit, 'amount', round(k.amount::numeric, 2), 'detail', k.detail,
                'accepted', exists (select 1 from payroll_cycle_lines l where l.cycle_employee_id = ce.id and l.source = 'attendance_suggestion'
                                    and l.source_ref ->> 'kind' = k.kind),
                'changedSinceAccepted', exists (select 1 from payroll_cycle_lines l where l.cycle_employee_id = ce.id and l.source = 'attendance_suggestion'
                                    and l.source_ref ->> 'kind' = k.kind and (l.source_ref ->> 'quantity')::numeric is distinct from k.quantity)
            ) as s
            from payroll_cycle_employees ce
            cross join lateral (
                select greatest(ce.base_salary, 0) / nullif((v_cycle.policy_snapshot ->> 'day_divisor')::numeric, 0) as day_rate
            ) r
            cross join lateral (
                -- unpaid leave already priced when the leave was approved
                select 'unpaid_leave'::text as kind, count(*)::numeric as quantity, 'days'::text as unit, coalesce(sum(-pa.amount), 0) as amount,
                       jsonb_agg(pa.work_date order by pa.work_date) as detail
                from payroll_adjustments pa
                where pa.user_id = ce.user_id and pa.status = 'active' and pa.kind = 'unpaid_leave_deduction'
                  and pa.work_date between v_cycle.period_start and v_cycle.period_end
                having count(*) > 0
                union all
                -- lateness minutes recorded on the timesheets of the period
                select 'late_minutes', coalesce(sum(ts.total_deduction_minutes), 0)::numeric, 'minutes',
                       coalesce(sum(ts.total_deduction_minutes), 0) / 60.0 * coalesce(r.day_rate, 0) / nullif((v_cycle.policy_snapshot ->> 'hours_per_day')::numeric, 0),
                       null::jsonb
                from timesheets ts
                where ts.user_id = ce.user_id and ts.period_start <= v_cycle.period_end and ts.period_end >= v_cycle.period_start
                having coalesce(sum(ts.total_deduction_minutes), 0) > 0
                union all
                -- overtime minutes on the timesheets of the period
                select 'overtime_minutes', coalesce(sum(ts.total_overtime_minutes), 0)::numeric, 'minutes',
                       coalesce(sum(ts.total_overtime_minutes), 0) / 60.0 * coalesce(r.day_rate, 0) / nullif((v_cycle.policy_snapshot ->> 'hours_per_day')::numeric, 0)
                           * coalesce((v_cycle.policy_snapshot ->> 'overtime_multiplier')::numeric, 1),
                       null::jsonb
                from timesheets ts
                where ts.user_id = ce.user_id and ts.period_start <= v_cycle.period_end and ts.period_end >= v_cycle.period_start
                having coalesce(sum(ts.total_overtime_minutes), 0) > 0
            ) k
            where ce.cycle_id = p_cycle_id and public.prosm_time_payroll_allows('payroll.enter_monthly_variables', ce.site_id)
        ) x
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_payroll_suggestions(uuid) from public, anon;
grant execute on function public.list_prosm_time_payroll_suggestions(uuid) to authenticated;

-- Validation --------------------------------------------------------------------------------------
create or replace function public.validate_prosm_time_payroll_cycle(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype;
    v_errors jsonb := '[]'::jsonb;
    v_warnings jsonb := '[]'::jsonb;
    v_threshold numeric;
begin
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null then raise exception 'PAYROLL CYCLE NOT FOUND'; end if;
    perform public.prosm_time_payroll_require('payroll.view', v_cycle.site_id)
        where not public.prosm_time_payroll_allows('payroll.edit_draft', v_cycle.site_id);
    v_threshold := coalesce((v_cycle.policy_snapshot ->> 'net_change_warning_percent')::numeric, 25);

    select coalesce(jsonb_agg(jsonb_build_object('code', 'NO_PROFILE', 'userId', user_id, 'fullName', full_name)), '[]'::jsonb) || v_errors into v_errors
    from payroll_cycle_employees where cycle_id = p_cycle_id and not has_profile;
    select v_errors || coalesce(jsonb_agg(jsonb_build_object('code', 'NO_BASIC_SALARY', 'userId', user_id, 'fullName', full_name)), '[]'::jsonb) into v_errors
    from payroll_cycle_employees where cycle_id = p_cycle_id and has_profile and base_salary <= 0;
    if not coalesce((v_cycle.policy_snapshot ->> 'allow_negative_net')::boolean, false) then
        select v_errors || coalesce(jsonb_agg(jsonb_build_object('code', 'NEGATIVE_NET', 'userId', user_id, 'fullName', full_name, 'net', net_salary)), '[]'::jsonb) into v_errors
        from payroll_cycle_employees where cycle_id = p_cycle_id and net_salary < 0;
    end if;
    select v_errors || coalesce(jsonb_agg(jsonb_build_object('code', 'PERCENT_WITHOUT_BASE', 'userId', ce.user_id, 'fullName', ce.full_name, 'line', l.name_ar)), '[]'::jsonb) into v_errors
    from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id
    where ce.cycle_id = p_cycle_id and l.calc_type = 'percent' and coalesce(l.base_amount, 0) = 0;
    select v_errors || coalesce(jsonb_agg(jsonb_build_object('code', 'DUPLICATE_LINE', 'userId', ce.user_id, 'fullName', ce.full_name, 'line', d.name_ar)), '[]'::jsonb) into v_errors
    from (select cycle_employee_id, component_id, min(name_ar) as name_ar from payroll_cycle_lines
          where component_id is not null and source = 'fixed' group by cycle_employee_id, component_id having count(*) > 1) d
    join payroll_cycle_employees ce on ce.id = d.cycle_employee_id where ce.cycle_id = p_cycle_id;

    -- warnings
    select coalesce(jsonb_agg(jsonb_build_object('code', 'ZERO_NET', 'userId', user_id, 'fullName', full_name)), '[]'::jsonb) into v_warnings
    from payroll_cycle_employees where cycle_id = p_cycle_id and has_profile and net_salary = 0;
    select v_warnings || coalesce(jsonb_agg(jsonb_build_object('code', 'PARTIAL_PERIOD', 'userId', user_id, 'fullName', full_name, 'factor', proration_factor)), '[]'::jsonb) into v_warnings
    from payroll_cycle_employees where cycle_id = p_cycle_id and proration_factor < 1;
    select v_warnings || coalesce(jsonb_agg(jsonb_build_object('code', 'NET_CHANGED', 'userId', ce.user_id, 'fullName', ce.full_name,
                                                               'previous', prev.net_salary, 'net', ce.net_salary)), '[]'::jsonb) into v_warnings
    from payroll_cycle_employees ce
    join lateral (
        select pce.net_salary from payroll_cycle_employees pce join payroll_cycles pc on pc.id = pce.cycle_id
        where pce.user_id = ce.user_id and pc.status in ('approved', 'locked') and pc.period_end < v_cycle.period_start
        order by pc.period_end desc limit 1
    ) prev on true
    where ce.cycle_id = p_cycle_id and prev.net_salary > 0 and abs(ce.net_salary - prev.net_salary) / prev.net_salary * 100 > v_threshold;
    select v_warnings || coalesce(jsonb_agg(jsonb_build_object('code', 'ATTENDANCE_CHANGED', 'cycleEmployeeId', (s ->> 'cycleEmployeeId'), 'fullName', s ->> 'fullName', 'kind', s ->> 'kind')), '[]'::jsonb)
    into v_warnings
    from jsonb_array_elements(public.list_prosm_time_payroll_suggestions(p_cycle_id)) s where (s ->> 'changedSinceAccepted')::boolean;

    return jsonb_build_object('errors', v_errors, 'warnings', v_warnings, 'canSubmit', jsonb_array_length(v_errors) = 0);
end;
$$;
revoke all on function public.validate_prosm_time_payroll_cycle(uuid) from public, anon;
grant execute on function public.validate_prosm_time_payroll_cycle(uuid) to authenticated;

-- Snapshot of the whole cycle as it is now (employees with their lines).
create or replace function public.prosm_time_payroll_snapshot(p_cycle_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'cycle', (select to_jsonb(c) - 'organization_id' from payroll_cycles c where c.id = p_cycle_id),
        'employees', coalesce((
            select jsonb_agg(to_jsonb(ce) - 'organization_id' || jsonb_build_object('lines', coalesce((
                select jsonb_agg(to_jsonb(l) - 'organization_id' order by l.sort_order, l.name_ar)
                from payroll_cycle_lines l where l.cycle_employee_id = ce.id), '[]'::jsonb)) order by ce.full_name)
            from payroll_cycle_employees ce where ce.cycle_id = p_cycle_id), '[]'::jsonb));
$$;
revoke all on function public.prosm_time_payroll_snapshot(uuid) from public, anon, authenticated;

-- Workflow ----------------------------------------------------------------------------------------
create or replace function public.transition_prosm_time_payroll_cycle(p_cycle_id uuid, p_action text, p_reason text default null,
                                                                       p_expected_version integer default null, p_acknowledge_warnings boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
    v_caller uuid := public.current_prosm_time_user_id();
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_check jsonb;
    v_ce record;
    v_line record;
    v_new_status text;
begin
    perform 1 from payroll_cycles where id = p_cycle_id for update;
    select * into v_cycle from payroll_cycles where id = p_cycle_id;
    if p_expected_version is not null and p_expected_version <> v_cycle.row_version then
        raise exception 'THIS CYCLE WAS CHANGED BY SOMEONE ELSE - RELOAD';
    end if;

    if p_action = 'submit' then
        perform public.prosm_time_payroll_require('payroll.edit_draft', v_cycle.site_id);
        if v_cycle.status not in ('draft', 'reopened') then raise exception 'ONLY A DRAFT OR REOPENED CYCLE IS SUBMITTED'; end if;
        v_check := public.validate_prosm_time_payroll_cycle(p_cycle_id);
        if jsonb_array_length(v_check -> 'errors') > 0 then raise exception 'THE CYCLE HAS BLOCKING ERRORS'; end if;
        if jsonb_array_length(v_check -> 'warnings') > 0 and not coalesce(p_acknowledge_warnings, false) then
            raise exception 'ACKNOWLEDGE THE WARNINGS FIRST';
        end if;
        update payroll_cycles set status = 'in_review', submitted_by = v_caller, submitted_at = now(),
            warnings_acknowledged_by = case when jsonb_array_length(v_check -> 'warnings') > 0 then v_caller end
        where id = p_cycle_id;
        v_new_status := 'in_review';

    elsif p_action = 'return' then
        perform public.prosm_time_payroll_require('payroll.review', v_cycle.site_id);
        if v_cycle.status <> 'in_review' then raise exception 'ONLY A CYCLE IN REVIEW IS RETURNED'; end if;
        if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
        update payroll_cycles set status = case when cycle_version > 0 then 'reopened' else 'draft' end where id = p_cycle_id;
        v_new_status := 'draft';

    elsif p_action = 'approve' then
        perform public.prosm_time_payroll_require('payroll.approve', v_cycle.site_id);
        if v_cycle.status <> 'in_review' then raise exception 'ONLY A CYCLE IN REVIEW IS APPROVED'; end if;
        if v_cycle.submitted_by = v_caller and not public.current_prosm_time_user_is_real_owner() then
            raise exception 'WHOEVER SUBMITTED THE CYCLE DOES NOT APPROVE IT';
        end if;
        v_check := public.validate_prosm_time_payroll_cycle(p_cycle_id);
        if jsonb_array_length(v_check -> 'errors') > 0 then raise exception 'THE CYCLE HAS BLOCKING ERRORS'; end if;
        update payroll_cycles set
            status = case when coalesce((policy_snapshot ->> 'auto_lock_on_approve')::boolean, false) then 'locked' else 'approved' end,
            cycle_version = cycle_version + 1, approved_by = v_caller, approved_at = now(),
            locked_by = case when coalesce((policy_snapshot ->> 'auto_lock_on_approve')::boolean, false) then v_caller end,
            locked_at = case when coalesce((policy_snapshot ->> 'auto_lock_on_approve')::boolean, false) then now() end
        where id = p_cycle_id
        returning status into v_new_status;
        -- installments of this cycle are paid; the plan ends at zero balance
        delete from payroll_installment_payments where cycle_id = p_cycle_id;
        for v_line in
            select l.* from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id
            where ce.cycle_id = p_cycle_id and l.installment_plan_id is not null and l.amount > 0
        loop
            insert into payroll_installment_payments (organization_id, plan_id, cycle_id, installment_no, amount)
            values (v_cycle.organization_id, v_line.installment_plan_id, p_cycle_id, v_line.installment_no, v_line.amount);
            update payroll_installment_plans p set
                paid_amount = (select coalesce(sum(amount), 0) from payroll_installment_payments x where x.plan_id = p.id),
                status = case when (select coalesce(sum(amount), 0) from payroll_installment_payments x where x.plan_id = p.id) >= p.total_amount then 'completed' else p.status end,
                row_version = row_version + 1, updated_at = now()
            where p.id = v_line.installment_plan_id;
        end loop;
        insert into payroll_cycle_snapshots (organization_id, cycle_id, cycle_version, data, created_by)
        select v_cycle.organization_id, p_cycle_id, c.cycle_version, public.prosm_time_payroll_snapshot(p_cycle_id), v_caller
        from payroll_cycles c where c.id = p_cycle_id;

    elsif p_action = 'lock' then
        perform public.prosm_time_payroll_require('payroll.approve', v_cycle.site_id);
        if v_cycle.status <> 'approved' then raise exception 'ONLY AN APPROVED CYCLE IS LOCKED'; end if;
        update payroll_cycles set status = 'locked', locked_by = v_caller, locked_at = now() where id = p_cycle_id;
        v_new_status := 'locked';

    elsif p_action = 'reopen' then
        perform public.prosm_time_payroll_require('payroll.reopen', v_cycle.site_id);
        if v_cycle.status not in ('approved', 'locked') then raise exception 'ONLY AN APPROVED OR LOCKED CYCLE IS REOPENED'; end if;
        if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
        -- reopening withdraws the published payslips and the installments it paid, in this same step
        delete from payroll_installment_payments where cycle_id = p_cycle_id;
        update payroll_installment_plans p set
            paid_amount = (select coalesce(sum(amount), 0) from payroll_installment_payments x where x.plan_id = p.id),
            status = case when p.status = 'completed' then 'active' else p.status end, row_version = row_version + 1, updated_at = now()
        where p.id in (select l.installment_plan_id from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id
                       where ce.cycle_id = p_cycle_id and l.installment_plan_id is not null);
        update payroll_cycles set status = 'reopened', reopened_by = v_caller, reopened_at = now(), reopen_reason = v_reason,
            published_version = null, published_at = null, published_by = null
        where id = p_cycle_id;
        v_new_status := 'reopened';

    elsif p_action = 'cancel' then
        perform public.prosm_time_payroll_require('payroll.edit_draft', v_cycle.site_id);
        if v_cycle.status not in ('draft', 'in_review', 'reopened') then raise exception 'AN APPROVED CYCLE IS REOPENED, NOT CANCELLED'; end if;
        if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
        update payroll_cycles set status = 'cancelled', cancelled_by = v_caller, cancelled_at = now(), cancel_reason = v_reason where id = p_cycle_id;
        v_new_status := 'cancelled';

    else
        raise exception 'INVALID ACTION';
    end if;

    update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = p_cycle_id;
    perform public.prosm_time_payroll_log(v_cycle.organization_id, 'payroll.cycle_' || p_action, 'payroll_cycles', p_cycle_id, null,
                                          'Payroll cycle ' || p_action, v_reason,
                                          jsonb_build_object('from', v_cycle.status, 'to', v_new_status, 'warningsAcknowledged', coalesce(p_acknowledge_warnings, false)));
    return jsonb_build_object('success', true, 'status', v_new_status);
end;
$$;
revoke all on function public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean) from public, anon;
grant execute on function public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean) to authenticated;

-- Publishing payslips (locked cycles only) -------------------------------------------------------------
create or replace function public.publish_prosm_time_payslips(p_cycle_id uuid, p_publish boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
    v_ce record;
begin
    perform public.prosm_time_payroll_require('payroll.publish_payslips', v_cycle.site_id);
    perform 1 from payroll_cycles where id = p_cycle_id for update;
    select * into v_cycle from payroll_cycles where id = p_cycle_id;
    if p_publish then
        if v_cycle.status <> 'locked' then raise exception 'PAYSLIPS ARE PUBLISHED FROM A LOCKED CYCLE ONLY'; end if;
        update payroll_cycles set published_version = cycle_version, published_at = now(), published_by = public.current_prosm_time_user_id(),
            publication_no = publication_no + 1, row_version = row_version + 1, updated_at = now()
        where id = p_cycle_id;
        if exists (select 1 from payroll_settings where organization_id = v_cycle.organization_id and employee_self_service) then
            for v_ce in select user_id from payroll_cycle_employees where cycle_id = p_cycle_id loop
                -- no amounts in the notification
                perform public.create_prosm_time_notification(v_cycle.organization_id, v_ce.user_id, 'payslip_published', 'normal',
                    'Your payslip is available', 'A new payslip was published for ' || v_cycle.title || '.', 'payroll_cycles', p_cycle_id, '{}'::jsonb);
            end loop;
        end if;
    else
        update payroll_cycles set published_version = null, published_at = null, published_by = null, row_version = row_version + 1, updated_at = now()
        where id = p_cycle_id;
    end if;
    perform public.prosm_time_payroll_log(v_cycle.organization_id, case when p_publish then 'payroll.payslips_published' else 'payroll.payslips_unpublished' end,
                                          'payroll_cycles', p_cycle_id, null, 'Payslips ' || case when p_publish then 'published' else 'withdrawn' end, null, '{}'::jsonb);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.publish_prosm_time_payslips(uuid, boolean) from public, anon;
grant execute on function public.publish_prosm_time_payslips(uuid, boolean) to authenticated;

-- the notification type
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('payslip_published' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''payslip_published''::text');
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- Reading ----------------------------------------------------------------------------------------------
create or replace function public.list_prosm_time_payroll_cycles()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    perform public.prosm_time_require_feature('payroll');
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', c.id, 'title', c.title, 'siteId', c.site_id, 'siteName', (select name from sites where id = c.site_id),
            'periodStart', c.period_start, 'periodEnd', c.period_end, 'status', c.status, 'cycleVersion', c.cycle_version,
            'rowVersion', c.row_version, 'publishedVersion', c.published_version,
            'employees', (select count(*) from payroll_cycle_employees ce where ce.cycle_id = c.id),
            'totals', (select coalesce(jsonb_agg(jsonb_build_object('currency', t.currency, 'net', t.net)), '[]'::jsonb)
                       from (select currency, sum(net_salary) as net from payroll_cycle_employees ce where ce.cycle_id = c.id group by currency) t)
        ) order by c.period_start desc, c.created_at desc)
        from payroll_cycles c
        where c.organization_id = public.current_prosm_time_organization_id()
          and public.prosm_time_payroll_allows('payroll.view', c.site_id)
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_payroll_cycles() from public, anon;
grant execute on function public.list_prosm_time_payroll_cycles() to authenticated;

create or replace function public.get_prosm_time_payroll_cycle(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
begin
    perform public.prosm_time_payroll_require('payroll.view', v_cycle.site_id)
        where not exists (select 1 from payroll_cycle_employees ce where ce.cycle_id = p_cycle_id and public.prosm_time_payroll_allows('payroll.view', ce.site_id));
    return jsonb_build_object(
        'cycle', to_jsonb(v_cycle) - 'organization_id' || jsonb_build_object('siteName', (select name from sites where id = v_cycle.site_id)),
        'can', jsonb_build_object(
            'edit', public.prosm_time_payroll_allows('payroll.edit_draft', v_cycle.site_id),
            'enterVariables', public.prosm_time_payroll_allows('payroll.enter_monthly_variables', v_cycle.site_id),
            'review', public.prosm_time_payroll_allows('payroll.review', v_cycle.site_id),
            'approve', public.prosm_time_payroll_allows('payroll.approve', v_cycle.site_id),
            'reopen', public.prosm_time_payroll_allows('payroll.reopen', v_cycle.site_id),
            'publish', public.prosm_time_payroll_allows('payroll.publish_payslips', v_cycle.site_id),
            'exportPayslips', public.prosm_time_payroll_allows('payroll.export_payslips', v_cycle.site_id),
            'exportSummary', public.prosm_time_payroll_allows('payroll.export_summary', v_cycle.site_id),
            'exportCombined', public.prosm_time_payroll_allows('payroll.export_combined_allowances', v_cycle.site_id),
            'import', public.prosm_time_payroll_allows('payroll.import', v_cycle.site_id)),
        'employees', coalesce((
            select jsonb_agg(to_jsonb(ce) - 'organization_id' || jsonb_build_object('lines', coalesce((
                select jsonb_agg(to_jsonb(l) - 'organization_id' order by l.sort_order, l.name_ar)
                from payroll_cycle_lines l where l.cycle_employee_id = ce.id), '[]'::jsonb)) order by ce.full_name)
            from payroll_cycle_employees ce
            where ce.cycle_id = p_cycle_id and public.prosm_time_payroll_allows('payroll.view', ce.site_id)), '[]'::jsonb));
end;
$$;
revoke all on function public.get_prosm_time_payroll_cycle(uuid) from public, anon;
grant execute on function public.get_prosm_time_payroll_cycle(uuid) to authenticated;

-- The three reports, from the approved snapshot (or the live draft, marked as such), with the
-- visibility rules applied on the server and an export serial number when exported.
create or replace function public.get_prosm_time_payroll_report(p_cycle_id uuid, p_report_type text, p_user_ids uuid[] default null,
                                                                 p_site_ids uuid[] default null, p_format text default 'preview')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
    v_key text;
    v_data jsonb;
    v_employees jsonb := '[]'::jsonb;
    v_excluded jsonb := '[]'::jsonb;
    v_emp jsonb;
    v_lines jsonb;
    v_serial bigint;
    v_is_draft boolean;
    v_org jsonb;
begin
    v_key := case p_report_type when 'payslip' then 'payroll.export_payslips' when 'summary' then 'payroll.export_summary'
                                when 'combined' then 'payroll.export_combined_allowances' else null end;
    if v_key is null then raise exception 'INVALID REPORT TYPE'; end if;
    if p_format not in ('preview', 'pdf', 'xlsx', 'zip') then raise exception 'INVALID FORMAT'; end if;
    perform public.prosm_time_require_feature('payroll');

    v_is_draft := v_cycle.status not in ('approved', 'locked');
    if v_is_draft then
        v_data := public.prosm_time_payroll_snapshot(p_cycle_id);
    else
        select data into v_data from payroll_cycle_snapshots where cycle_id = p_cycle_id and cycle_version = v_cycle.cycle_version;
    end if;

    for v_emp in select * from jsonb_array_elements(coalesce(v_data -> 'employees', '[]'::jsonb)) loop
        if p_user_ids is not null and not ((v_emp ->> 'user_id')::uuid = any(p_user_ids)) then continue; end if;
        if p_site_ids is not null and not (nullif(v_emp ->> 'site_id', '')::uuid = any(p_site_ids)) then continue; end if;
        if not public.prosm_time_payroll_allows(v_key, nullif(v_emp ->> 'site_id', '')::uuid) then
            v_excluded := v_excluded || jsonb_build_object('userId', v_emp ->> 'user_id', 'fullName', v_emp ->> 'full_name', 'reason', 'OUT_OF_SCOPE');
            continue;
        end if;
        -- report 1 and 2: only lines in the net (never the extra allowances); report 3: basic + allowances
        select coalesce(jsonb_agg(l order by (l ->> 'sort_order')::int, l ->> 'name_ar'), '[]'::jsonb) into v_lines
        from jsonb_array_elements(v_emp -> 'lines') l
        where case p_report_type
                  when 'payslip' then (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean
                  when 'summary' then (l ->> 'show_in_summary')::boolean and (l ->> 'include_in_net')::boolean
                  else (l ->> 'is_basic')::boolean or ((l ->> 'category') = 'allowance' and (l ->> 'include_in_combined')::boolean)
              end;
        v_employees := v_employees || ((v_emp - 'lines') || jsonb_build_object('lines', v_lines));
    end loop;

    if p_format <> 'preview' then
        update payroll_settings set last_export_serial = last_export_serial + 1 where organization_id = v_cycle.organization_id
        returning last_export_serial into v_serial;
        insert into payroll_exports (organization_id, serial_no, cycle_id, cycle_version, report_type, file_format, employee_count, exported_by)
        values (v_cycle.organization_id, v_serial, p_cycle_id, v_cycle.cycle_version, p_report_type, p_format, jsonb_array_length(v_employees),
                public.current_prosm_time_user_id());
        perform public.prosm_time_payroll_log(v_cycle.organization_id, 'payroll.exported', 'payroll_cycles', p_cycle_id, null,
                                              'Payroll report exported', null,
                                              jsonb_build_object('serial', v_serial, 'reportType', p_report_type, 'format', p_format,
                                                                 'employees', jsonb_array_length(v_employees), 'cycleVersion', v_cycle.cycle_version));
    end if;

    select jsonb_build_object('name', o.name, 'logoUrl', o.logo_url) into v_org from organizations o where o.id = v_cycle.organization_id;
    return jsonb_build_object(
        'reportType', p_report_type,
        'serial', v_serial,
        'draft', v_is_draft,
        'cycle', jsonb_build_object('id', v_cycle.id, 'title', v_cycle.title, 'periodStart', v_cycle.period_start, 'periodEnd', v_cycle.period_end,
                                    'status', v_cycle.status, 'cycleVersion', v_cycle.cycle_version, 'siteName', (select name from sites where id = v_cycle.site_id)),
        'organization', v_org,
        'settings', jsonb_build_object('taxNotice', v_cycle.policy_snapshot ->> 'tax_notice', 'footerNote', v_cycle.policy_snapshot ->> 'footer_note',
                                       'showSignatures', coalesce((v_cycle.policy_snapshot ->> 'show_signatures')::boolean, true),
                                       'language', coalesce(v_cycle.policy_snapshot ->> 'report_language', 'bilingual')),
        'employees', v_employees,
        'excluded', v_excluded,
        'totals', coalesce((
            select jsonb_agg(jsonb_build_object('currency', currency, 'earnings', earnings, 'deductions', deductions, 'installments', installments,
                                                'net', net, 'base', base, 'allowances', allowances, 'combined', combined, 'count', cnt))
            from (
                select e ->> 'currency' as currency, sum((e ->> 'total_earnings')::numeric) as earnings, sum((e ->> 'total_deductions')::numeric) as deductions,
                       sum((e ->> 'total_installments')::numeric) as installments, sum((e ->> 'net_salary')::numeric) as net,
                       sum((e ->> 'base_salary')::numeric) as base, sum((e ->> 'total_allowances')::numeric) as allowances,
                       sum((e ->> 'combined_total')::numeric) as combined, count(*) as cnt
                from jsonb_array_elements(v_employees) e group by e ->> 'currency'
            ) t), '[]'::jsonb)
    );
end;
$$;
revoke all on function public.get_prosm_time_payroll_report(uuid, text, uuid[], uuid[], text) from public, anon;
grant execute on function public.get_prosm_time_payroll_report(uuid, text, uuid[], uuid[], text) to authenticated;

-- Employee self-service: one's own published payslips (when the organisation enables it).
create or replace function public.list_my_prosm_time_payslips()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from payroll_settings where organization_id = public.current_prosm_time_organization_id() and employee_self_service) then
        return '[]'::jsonb;
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('cycleId', c.id, 'title', c.title, 'periodStart', c.period_start, 'periodEnd', c.period_end,
                                            'publishedAt', c.published_at, 'cycleVersion', c.published_version) order by c.period_start desc)
        from payroll_cycles c
        where c.organization_id = public.current_prosm_time_organization_id() and c.status = 'locked' and c.published_version is not null
          and exists (select 1 from payroll_cycle_employees ce where ce.cycle_id = c.id and ce.user_id = v_me)
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_my_prosm_time_payslips() from public, anon;
grant execute on function public.list_my_prosm_time_payslips() to authenticated;

create or replace function public.get_my_prosm_time_payslip(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_cycle payroll_cycles%rowtype;
    v_emp jsonb;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null or v_cycle.status <> 'locked' or v_cycle.published_version is null
       or not exists (select 1 from payroll_settings where organization_id = v_cycle.organization_id and employee_self_service) then
        raise exception 'PAYSLIP NOT AVAILABLE';
    end if;
    select e into v_emp from payroll_cycle_snapshots s, jsonb_array_elements(s.data -> 'employees') e
    where s.cycle_id = p_cycle_id and s.cycle_version = v_cycle.published_version and (e ->> 'user_id')::uuid = v_me;
    if v_emp is null then raise exception 'PAYSLIP NOT AVAILABLE'; end if;
    return jsonb_build_object(
        'cycle', jsonb_build_object('title', v_cycle.title, 'periodStart', v_cycle.period_start, 'periodEnd', v_cycle.period_end, 'cycleVersion', v_cycle.published_version),
        'organization', (select jsonb_build_object('name', name, 'logoUrl', logo_url) from organizations where id = v_cycle.organization_id),
        'settings', jsonb_build_object('taxNotice', v_cycle.policy_snapshot ->> 'tax_notice', 'footerNote', v_cycle.policy_snapshot ->> 'footer_note'),
        'employee', (v_emp - 'lines') || jsonb_build_object('lines', coalesce((
            select jsonb_agg(l order by (l ->> 'sort_order')::int) from jsonb_array_elements(v_emp -> 'lines') l
            where (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean), '[]'::jsonb)));
end;
$$;
revoke all on function public.get_my_prosm_time_payslip(uuid) from public, anon;
grant execute on function public.get_my_prosm_time_payslip(uuid) to authenticated;

-- Import (all rows or none) ------------------------------------------------------------------------------
create or replace function public.import_prosm_time_payroll_lines(p_cycle_id uuid, p_rows jsonb, p_file_name text, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype := public.prosm_time_payroll_cycle(p_cycle_id);
    v_row jsonb;
    v_i integer := 0;
    v_errors jsonb := '[]'::jsonb;
    v_ce payroll_cycle_employees%rowtype;
    v_component payroll_components%rowtype;
    v_amount numeric;
    v_ok jsonb := '[]'::jsonb;
    v_seen text[] := array[]::text[];
    v_key text;
begin
    perform public.prosm_time_payroll_require('payroll.import', v_cycle.site_id);
    perform public.prosm_time_payroll_require_editable(v_cycle);
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'INVALID ROWS'; end if;
    if jsonb_array_length(p_rows) > 5000 then raise exception 'AT MOST 5000 ROWS'; end if;
    for v_row in select * from jsonb_array_elements(p_rows) loop
        v_i := v_i + 1;
        v_ce := null;
        select ce.* into v_ce from payroll_cycle_employees ce join users u on u.id = ce.user_id
        where ce.cycle_id = p_cycle_id
          and (lower(u.email) = lower(trim(coalesce(v_row ->> 'email', '#'))) or ce.employee_code = trim(coalesce(v_row ->> 'employeeCode', '#')))
        limit 1;
        if v_ce.id is null then v_errors := v_errors || jsonb_build_object('row', v_i, 'code', 'EMPLOYEE_NOT_IN_CYCLE'); continue; end if;
        if not public.prosm_time_payroll_allows('payroll.import', v_ce.site_id) then v_errors := v_errors || jsonb_build_object('row', v_i, 'code', 'OUT_OF_SCOPE'); continue; end if;
        select * into v_component from payroll_components
        where organization_id = v_cycle.organization_id and is_active and source = 'variable' and calc_type = 'amount'
          and (name_ar = trim(coalesce(v_row ->> 'component', '#')) or lower(name_en) = lower(trim(coalesce(v_row ->> 'component', '#'))))
        limit 1;
        if v_component.id is null then v_errors := v_errors || jsonb_build_object('row', v_i, 'code', 'UNKNOWN_COMPONENT'); continue; end if;
        begin
            v_amount := (v_row ->> 'amount')::numeric;
        exception when others then
            v_amount := null;
        end;
        if v_amount is null or v_amount < 0 then v_errors := v_errors || jsonb_build_object('row', v_i, 'code', 'INVALID_AMOUNT'); continue; end if;
        v_key := v_ce.id::text || ':' || v_component.id::text;
        if v_key = any(v_seen) then v_errors := v_errors || jsonb_build_object('row', v_i, 'code', 'DUPLICATE_ROW'); continue; end if;
        v_seen := v_seen || v_key;
        v_ok := v_ok || jsonb_build_object('cycleEmployeeId', v_ce.id, 'componentId', v_component.id, 'amount', v_amount, 'notes', v_row ->> 'notes');
    end loop;

    if jsonb_array_length(v_errors) = 0 and not coalesce(p_dry_run, true) then
        for v_row in select * from jsonb_array_elements(v_ok) loop
            perform public.save_prosm_time_payroll_line((v_row ->> 'cycleEmployeeId')::uuid, null, (v_row ->> 'componentId')::uuid,
                                                       (v_row ->> 'amount')::numeric, v_row ->> 'notes', null, 'import', null);
        end loop;
        perform public.prosm_time_payroll_log(v_cycle.organization_id, 'payroll.imported', 'payroll_cycles', p_cycle_id, null, 'Payroll lines imported', null,
                                              jsonb_build_object('fileName', left(coalesce(p_file_name, ''), 120), 'rows', jsonb_array_length(v_ok)));
    end if;
    return jsonb_build_object('rows', v_i, 'valid', jsonb_array_length(v_ok), 'errors', v_errors,
                              'saved', jsonb_array_length(v_errors) = 0 and not coalesce(p_dry_run, true));
end;
$$;
revoke all on function public.import_prosm_time_payroll_lines(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.import_prosm_time_payroll_lines(uuid, jsonb, text, boolean) to authenticated;

commit;
