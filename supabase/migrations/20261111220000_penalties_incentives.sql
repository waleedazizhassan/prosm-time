-- HR suite feature 1 (spec 2026-11-11): the graded penalties bylaw and incentives.
--
-- The company writes its own bylaw (no legal value is written by PROSM): the deduction cap, the appeal
-- window and the liability acknowledgement are required before the first publication. Every publication
-- is a new, immutable version with a date it applies from; a violation keeps the rule it was recorded
-- under (rule_snapshot) even if the bylaw changes while it waits. Violations come from attendance
-- (lateness, early leave, absence, an out-of-zone reason refused) or are recorded by hand (with a photo);
-- the occurrence within the look-back period picks the step of the ladder; each penalty type has its own
-- steps before approval (written investigation, the employee's reply) and its approval levels in order
-- (manager -> personnel -> owner). The employee acknowledges ("received", not "agreed") or appeals within
-- the window; an appeal goes to personnel/the owner. Approved deductions (Pro) go to the open payroll
-- cycle as a deduction line, never above the company's cap (the rest is carried to the next cycle); a
-- cancelled one already paid is settled back. On Business (no payroll) the deduction is recorded as an
-- action with no money. Incentives use the same approval path and become an earning line.
-- Not live until the owner approves (HR suite).
--
-- Review 2026-11-11 (security team): cancelled cycles never hold money back, refunds and clawbacks are
-- worked out at build time from approved/locked cycles, the cap is per calendar month, evidence lives
-- outside the person's folder, a reduction is lighter, one person approves one level, managers see no money.
--
-- Rollback: unschedule 'prosm-time-penalties'; drop the triggers penalties_follow_*; restore
-- prosm_time_payroll_build_employee from 20261110180000 (drop the penalty/incentive block); drop the
-- functions *_prosm_time_penalt*, *_prosm_time_violation*, *_prosm_time_incentive* and the tables
-- penalty_payroll_postings, employee_violation_steps, employee_violations, employee_incentives,
-- incentive_rules, bylaw_versions, violation_types, penalty_action_types, penalty_settings.

begin;

-- ---------------------------------------------------------------- tables
create table if not exists public.penalty_settings (
    organization_id uuid primary key references public.organizations(id) on delete cascade,
    cap_unit text check (cap_unit in ('days_per_month', 'percent_of_wage', 'both')),
    cap_days numeric(6,2) check (cap_days is null or cap_days > 0),
    cap_percent numeric(6,2) check (cap_percent is null or (cap_percent > 0 and cap_percent <= 100)),
    max_days_to_impose integer check (max_days_to_impose is null or max_days_to_impose between 1 and 3650),
    appeal_window_days integer check (appeal_window_days is null or appeal_window_days between 0 and 365),
    incentive_levels text[] not null default array['hr'],
    liability_acknowledged_by uuid references public.users(id) on delete set null,
    liability_acknowledged_at timestamptz,
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now()
);
alter table public.penalty_settings enable row level security;
revoke all on public.penalty_settings from public, anon, authenticated;

create table if not exists public.penalty_action_types (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    code text not null check (code ~ '^[a-z_]{2,40}$'),
    name text check (name is null or length(trim(name)) between 1 and 80),
    kind text not null check (kind in ('warning', 'deduction', 'suspension', 'investigation', 'other')),
    unit text check (unit in ('days', 'hours', 'amount')),
    requires_investigation boolean not null default false,
    requires_response boolean not null default false,
    response_days integer check (response_days is null or response_days between 1 and 60),
    reporter_cannot_approve boolean not null default true,
    levels text[] not null default array['manager'],
    auto_approve boolean not null default false,
    is_builtin boolean not null default false,
    is_active boolean not null default true,
    sort_order integer not null default 100,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, code),
    constraint penalty_action_types_named check (is_builtin or name is not null),
    constraint penalty_action_types_unit check ((kind = 'deduction') = (unit is not null) or (kind = 'suspension' and unit = 'days')),
    constraint penalty_action_types_levels check (cardinality(levels) between 1 and 3 and levels <@ array['manager', 'hr', 'owner']),
    constraint penalty_action_types_response check (not requires_response or response_days is not null),
    constraint penalty_action_types_auto check (not auto_approve or (kind = 'warning' and not requires_investigation and not requires_response))
);
create index if not exists penalty_action_types_org_idx on public.penalty_action_types (organization_id);
alter table public.penalty_action_types enable row level security;
revoke all on public.penalty_action_types from public, anon, authenticated;

create table if not exists public.violation_types (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text check (name is null or length(trim(name)) between 1 and 100),
    template_key text,
    source text not null check (source in ('attendance_late', 'attendance_early_leave', 'attendance_absent', 'geofence_exit', 'manual')),
    threshold_minutes integer check (threshold_minutes is null or threshold_minutes between 0 and 1440),
    lookback_days integer not null default 180 check (lookback_days between 1 and 3650),
    steps jsonb not null default '[]'::jsonb,
    is_active boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint violation_types_named check (name is not null or template_key is not null)
);
create index if not exists violation_types_org_idx on public.violation_types (organization_id);
alter table public.violation_types enable row level security;
revoke all on public.violation_types from public, anon, authenticated;

create table if not exists public.bylaw_versions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    version integer not null,
    effective_from date not null,
    reset_counters boolean not null default false,
    snapshot jsonb not null,
    announcement_id uuid references public.announcements(id) on delete set null,
    published_by uuid references public.users(id) on delete set null,
    published_at timestamptz not null default now(),
    unique (organization_id, version)
);
create index if not exists bylaw_versions_org_idx on public.bylaw_versions (organization_id, effective_from desc);
alter table public.bylaw_versions enable row level security;
revoke all on public.bylaw_versions from public, anon, authenticated;
-- a published version never changes
create or replace function public.prosm_time_bylaw_versions_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'A PUBLISHED BYLAW VERSION CANNOT BE CHANGED';
    end if;
    if new.snapshot is distinct from old.snapshot or new.effective_from is distinct from old.effective_from
       or new.version is distinct from old.version or new.reset_counters is distinct from old.reset_counters then
        raise exception 'A PUBLISHED BYLAW VERSION CANNOT BE CHANGED';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_bylaw_versions_immutable() from public, anon, authenticated;
drop trigger if exists bylaw_versions_immutable on public.bylaw_versions;
create trigger bylaw_versions_immutable before update or delete on public.bylaw_versions
for each row when (pg_trigger_depth() = 0) execute function public.prosm_time_bylaw_versions_immutable();

create table if not exists public.employee_violations (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    violation_type_id uuid not null references public.violation_types(id) on delete restrict,
    bylaw_version_id uuid not null references public.bylaw_versions(id) on delete restrict,
    rule_snapshot jsonb not null,
    occurred_on date not null,
    source text not null,
    source_ref text,
    note text check (note is null or length(note) <= 1000),
    evidence_path text,
    reported_by uuid references public.users(id) on delete set null,
    occurrence_number integer not null,
    suggested jsonb not null,
    final_action jsonb not null,
    amount numeric(14,2) check (amount is null or amount >= 0),
    levels text[] not null,
    current_level integer not null default 0,
    status text not null check (status in ('pending_investigation', 'pending_response', 'pending_approval', 'approved', 'reduced',
                                             'rejected', 'appealed', 'cancelled', 'lapsed')),
    response_due_at timestamptz,
    employee_response text,
    employee_notified boolean not null default false,
    decided_by uuid references public.users(id) on delete set null,
    decided_at timestamptz,
    decision_note text,
    acknowledged_at timestamptz,
    refused_ack_at timestamptz,
    refused_ack_witness text,
    appeal_text text,
    appealed_at timestamptz,
    status_before_appeal text,
    appeal_decided_by uuid references public.users(id) on delete set null,
    appeal_decided_at timestamptz,
    settlement_amount numeric(14,2),
    settlement_cycle_id uuid references public.payroll_cycles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index if not exists employee_violations_source_ref on public.employee_violations (organization_id, source_ref) where source_ref is not null;
create index if not exists employee_violations_user_idx on public.employee_violations (user_id, violation_type_id, occurred_on desc);
create index if not exists employee_violations_org_idx on public.employee_violations (organization_id, status);
alter table public.employee_violations enable row level security;
revoke all on public.employee_violations from public, anon, authenticated;

create table if not exists public.employee_violation_steps (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    violation_id uuid not null references public.employee_violations(id) on delete cascade,
    step_type text not null,
    level_order integer,
    actor_id uuid references public.users(id) on delete set null,
    note text,
    attachment_path text,
    data jsonb,
    created_at timestamptz not null default now()
);
create index if not exists employee_violation_steps_idx on public.employee_violation_steps (violation_id, created_at);
create index if not exists employee_violation_steps_org_idx on public.employee_violation_steps (organization_id);
alter table public.employee_violation_steps enable row level security;
revoke all on public.employee_violation_steps from public, anon, authenticated;

create table if not exists public.incentive_rules (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text check (name is null or length(trim(name)) between 1 and 100),
    template_key text,
    source text not null check (source in ('no_late_month', 'full_attendance_month')),
    amount_type text not null check (amount_type in ('amount', 'days', 'percent')),
    value numeric(14,2) not null check (value > 0),
    is_active boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint incentive_rules_named check (name is not null or template_key is not null),
    constraint incentive_rules_percent check (amount_type <> 'percent' or value <= 100)
);
create index if not exists incentive_rules_org_idx on public.incentive_rules (organization_id);
alter table public.incentive_rules enable row level security;
revoke all on public.incentive_rules from public, anon, authenticated;

create table if not exists public.employee_incentives (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    rule_id uuid references public.incentive_rules(id) on delete set null,
    source_ref text,
    period_month date,
    reason text not null check (length(trim(reason)) between 1 and 500),
    amount_type text not null check (amount_type in ('amount', 'days', 'percent')),
    value numeric(14,2) not null check (value > 0),
    amount numeric(14,2) check (amount is null or amount >= 0),
    levels text[] not null,
    current_level integer not null default 0,
    status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected', 'cancelled')),
    created_by uuid references public.users(id) on delete set null,
    approvers uuid[] not null default '{}',
    decided_by uuid references public.users(id) on delete set null,
    decided_at timestamptz,
    decision_note text,
    payroll_cycle_id uuid references public.payroll_cycles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index if not exists employee_incentives_source_ref on public.employee_incentives (organization_id, source_ref) where source_ref is not null;
create index if not exists employee_incentives_user_idx on public.employee_incentives (user_id, created_at desc);
create index if not exists employee_incentives_org_idx on public.employee_incentives (organization_id, status);
alter table public.employee_incentives enable row level security;
revoke all on public.employee_incentives from public, anon, authenticated;

-- what each violation has taken from each cycle (a deduction above the cap is carried to the next one)
create table if not exists public.penalty_payroll_postings (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    violation_id uuid not null references public.employee_violations(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    amount numeric(14,2) not null check (amount > 0),
    created_at timestamptz not null default now(),
    unique (violation_id, cycle_id)
);
create index if not exists penalty_payroll_postings_org_idx on public.penalty_payroll_postings (organization_id);
alter table public.penalty_payroll_postings enable row level security;
revoke all on public.penalty_payroll_postings from public, anon, authenticated;

-- payroll lines may come from a penalty or an incentive
alter table public.payroll_cycle_lines drop constraint if exists payroll_cycle_lines_source_check;
alter table public.payroll_cycle_lines add constraint payroll_cycle_lines_source_check
    check (source in ('fixed', 'variable', 'installment', 'attendance_suggestion', 'import', 'statutory', 'penalty', 'incentive'));

-- ---------------------------------------------------------------- notification types
do $types$
declare
    v_def text;
    v_new text := '''penalty_review''::text, ''penalty_response''::text, ''penalty_decided''::text, ''penalty_appeal''::text, ''penalty_appeal_decided''::text, ''incentive_review''::text, ''incentive_granted''::text';
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('penalty_review' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ' || v_new);
        if position('penalty_review' in v_def) = 0 then raise exception 'notification type anchor not found'; end if;
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- ---------------------------------------------------------------- evidence photos (a manager photographs a violation)
create or replace function public.prosm_time_hr_evidence_allowed(p_user_text text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    return public.prosm_time_caller_has_authority_over(p_user_text::uuid);
exception when others then
    return false;
end;
$$;
revoke all on function public.prosm_time_hr_evidence_allowed(text) from public, anon;
grant execute on function public.prosm_time_hr_evidence_allowed(text) to authenticated;

drop policy if exists "hr files: managers add violation evidence" on storage.objects;
create policy "hr files: managers add violation evidence" on storage.objects for insert to authenticated
with check (
    bucket_id = 'hr-files'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (storage.foldername(name))[2] = 'evidence'
    and public.prosm_time_hr_evidence_allowed((storage.foldername(name))[3])
);
drop policy if exists "hr files: managers read violation evidence" on storage.objects;
create policy "hr files: managers read violation evidence" on storage.objects for select to authenticated
using (
    bucket_id = 'hr-files'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (storage.foldername(name))[2] = 'evidence'
    and public.prosm_time_hr_evidence_allowed((storage.foldername(name))[3])
);

-- ---------------------------------------------------------------- helpers
-- the basic penalty types every company starts with (names in the app's language; values are the company's)
create or replace function public.prosm_time_penalties_seed(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
    insert into penalty_settings (organization_id) values (p_org) on conflict do nothing;
    insert into penalty_action_types (organization_id, code, kind, unit, levels, is_builtin, sort_order)
    select p_org, x.code, x.kind, x.unit, x.levels, true, x.ord
    from (values
        ('verbal_warning', 'warning', null, array['manager'], 10),
        ('written_warning', 'warning', null, array['manager'], 20),
        ('deduct_hours', 'deduction', 'hours', array['hr'], 30),
        ('deduct_days', 'deduction', 'days', array['hr'], 40),
        ('deduct_amount', 'deduction', 'amount', array['hr'], 50),
        ('suspension', 'suspension', 'days', array['hr', 'owner'], 60),
        ('investigation', 'investigation', null, array['hr'], 70)
    ) as x(code, kind, unit, levels, ord)
    on conflict (organization_id, code) do nothing;
$$;
revoke all on function public.prosm_time_penalties_seed(uuid) from public, anon, authenticated;

-- the reader may set the bylaw and see every violation (the owner or personnel managers)
create or replace function public.prosm_time_penalties_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.prosm_time_is_hr(); $$;
revoke all on function public.prosm_time_penalties_admin() from public, anon, authenticated;

-- who acts at a level for this person
create or replace function public.prosm_time_penalty_level_people(p_subject uuid, p_level text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := (select organization_id from users where id = p_subject);
    v_found boolean := false;
    v_id uuid;
begin
    if p_level = 'manager' then
        for v_id in
            select distinct u.id from users u
            join site_assignments msa on msa.user_id = u.id and msa.role_at_site = 'manager'
            join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = p_subject
            where u.organization_id = v_org and u.is_active and u.id <> p_subject and not u.is_owner
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_subject)
        loop
            v_found := true;
            return next v_id;
        end loop;
        if v_found then return; end if;
        -- no manager at their sites: the owner
        p_level := 'owner';
    end if;
    if p_level = 'hr' then
        for v_id in select x from public.prosm_time_hr_people(v_org) x where x <> p_subject loop
            return next v_id;
        end loop;
        return;
    end if;
    return query select u.id from users u where u.organization_id = v_org and u.is_owner and u.is_active and u.id <> p_subject;
end;
$$;
revoke all on function public.prosm_time_penalty_level_people(uuid, text) from public, anon, authenticated;

-- may the reader act at this level for this person (the owner may act at every level)
create or replace function public.prosm_time_penalty_can_act_level(p_subject uuid, p_level text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select p_subject <> public.current_prosm_time_user_id() and (
        public.current_prosm_time_user_is_owner()
        or case p_level
            when 'manager' then public.prosm_time_caller_has_authority_over(p_subject) or public.prosm_time_is_hr()
            when 'hr' then public.prosm_time_is_hr()
            else false
        end);
$$;
revoke all on function public.prosm_time_penalty_can_act_level(uuid, text) from public, anon, authenticated;

-- the day wage from the person's basic salary (the salary card) and the payroll day divisor; null when
-- the company has no payroll or the person no salary card
create or replace function public.prosm_time_day_wage(p_user uuid, p_day date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select case when not public.prosm_time_plan_allows(u.organization_id, 'payroll') then null else (
        select coalesce(
            (select pc.amount from payroll_profiles p
             join payroll_profile_components pc on pc.profile_id = p.id
             join payroll_components c on c.id = pc.component_id and c.is_basic
             where p.user_id = p_user and p.is_active and pc.effective_from <= p_day and (pc.effective_to is null or pc.effective_to >= p_day)
             order by pc.effective_from desc limit 1),
            (select c.default_amount from payroll_components c
             where c.organization_id = u.organization_id and c.is_basic and c.is_active and c.applies_to_all
               and exists (select 1 from payroll_profiles p where p.user_id = p_user and p.is_active))
        ) / nullif((select s.day_divisor from payroll_settings s where s.organization_id = u.organization_id), 0)
    ) end
    from users u where u.id = p_user;
$$;
revoke all on function public.prosm_time_day_wage(uuid, date) from public, anon, authenticated;

-- the money of an action (days, hours or a fixed amount); null when there is none or no payroll
create or replace function public.prosm_time_penalty_amount(p_user uuid, p_action jsonb, p_day date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_wage numeric;
    v_value numeric := nullif(p_action ->> 'value', '')::numeric;
    v_org uuid := (select organization_id from users where id = p_user);
begin
    if p_action ->> 'kind' <> 'deduction' or v_value is null or not public.prosm_time_plan_allows(v_org, 'payroll') then return null; end if;
    if p_action ->> 'unit' = 'amount' then return round(v_value, 2); end if;
    v_wage := public.prosm_time_day_wage(p_user, p_day);
    if v_wage is null then return null; end if;
    if p_action ->> 'unit' = 'days' then return round(v_value * v_wage, 2); end if;
    if p_action ->> 'unit' = 'hours' then
        return round(v_value * v_wage / nullif((select hours_per_day from payroll_settings where organization_id = v_org), 0), 2);
    end if;
    return null;
end;
$$;
revoke all on function public.prosm_time_penalty_amount(uuid, jsonb, date) from public, anon, authenticated;

-- the bylaw version in force on a day
create or replace function public.prosm_time_bylaw_for(p_org uuid, p_day date)
returns bylaw_versions
language sql
stable
security definer
set search_path = public
as $$
    select * from bylaw_versions where organization_id = p_org and effective_from <= p_day order by effective_from desc, version desc limit 1;
$$;
revoke all on function public.prosm_time_bylaw_for(uuid, date) from public, anon, authenticated;

-- payroll follows: every open cycle of the person is rebuilt
create or replace function public.prosm_time_penalties_refresh_payroll(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ce record;
begin
    for v_ce in
        select ce.id, ce.cycle_id from payroll_cycle_employees ce join payroll_cycles c on c.id = ce.cycle_id
        where ce.user_id = p_user and c.status in ('draft', 'reopened')
    loop
        perform public.prosm_time_payroll_build_employee(v_ce.id);
        update payroll_cycles set row_version = row_version + 1, updated_at = now() where id = v_ce.cycle_id;
    end loop;
end;
$$;
revoke all on function public.prosm_time_penalties_refresh_payroll(uuid) from public, anon, authenticated;

-- a notification to everyone at a level for a violation or an incentive
create or replace function public.prosm_time_penalty_notify_level(p_org uuid, p_subject uuid, p_level text, p_type text, p_title text, p_body text,
                                                                   p_entity text, p_entity_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_to uuid;
begin
    for v_to in select * from public.prosm_time_penalty_level_people(p_subject, p_level) loop
        perform public.create_prosm_time_notification(p_org, v_to, p_type, 'normal', p_title, p_body, p_entity, p_entity_id, p_data);
    end loop;
end;
$$;
revoke all on function public.prosm_time_penalty_notify_level(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- the data every violation notification carries (the app writes the words)
create or replace function public.prosm_time_violation_note_data(v employee_violations)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'kind', 'violation', 'violationId', v.id, 'userId', v.user_id,
        'employeeName', (select full_name from users where id = v.user_id),
        'violationName', v.rule_snapshot #>> '{type,name}', 'templateKey', v.rule_snapshot #>> '{type,templateKey}',
        'actionCode', v.final_action ->> 'code', 'actionName', v.final_action ->> 'name', 'value', v.final_action ->> 'value',
        'unit', v.final_action ->> 'unit', 'occurrence', v.occurrence_number, 'date', v.occurred_on, 'amount', v.amount);
$$;
revoke all on function public.prosm_time_violation_note_data(employee_violations) from public, anon, authenticated;

-- ---------------------------------------------------------------- creating a violation
create or replace function public.prosm_time_create_violation(p_org uuid, p_user uuid, p_type_id uuid, p_day date, p_source text, p_source_ref text,
                                                               p_note text, p_evidence text, p_reporter uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_version bylaw_versions%rowtype;
    v_type jsonb;
    v_step jsonb;
    v_action jsonb;
    v_count integer;
    v_reset date;
    v_status text;
    v_id uuid;
    v_amount numeric;
    v_levels text[];
    v_v employee_violations%rowtype;
    v_data jsonb;
begin
    v_version := public.prosm_time_bylaw_for(p_org, p_day);
    if v_version.id is null then raise exception 'THE PENALTY BYLAW IS NOT ACTIVE'; end if;
    select x into v_type from jsonb_array_elements(v_version.snapshot -> 'violationTypes') x where x ->> 'id' = p_type_id::text;
    if v_type is null then raise exception 'THIS VIOLATION IS NOT IN THE BYLAW IN FORCE ON THAT DAY'; end if;
    if p_source_ref is not null and exists (select 1 from employee_violations where organization_id = p_org and source_ref = p_source_ref) then
        return (select id from employee_violations where organization_id = p_org and source_ref = p_source_ref);
    end if;

    -- the occurrence: the same violation in the look-back period (refused, cancelled and lapsed ones do not count;
    -- a version published with "start counting again" starts the count from its date)
    select max(effective_from) into v_reset from bylaw_versions where organization_id = p_org and reset_counters and effective_from <= p_day;
    select count(*) into v_count from employee_violations e
    where e.user_id = p_user and e.violation_type_id = p_type_id
      and e.status not in ('rejected', 'cancelled', 'lapsed')
      and e.occurred_on <= p_day and e.occurred_on > p_day - (v_type ->> 'lookbackDays')::integer
      and (v_reset is null or e.occurred_on >= v_reset);
    v_count := v_count + 1;

    -- the step: the highest one at or below the occurrence ("4 and after")
    select s into v_step from jsonb_array_elements(v_type -> 'steps') s
    where (s ->> 'occurrence')::integer <= v_count order by (s ->> 'occurrence')::integer desc limit 1;
    if v_step is null then
        select s into v_step from jsonb_array_elements(v_type -> 'steps') s order by (s ->> 'occurrence')::integer limit 1;
    end if;
    if v_step is null then raise exception 'THIS VIOLATION HAS NO PENALTY STEPS'; end if;
    select a || jsonb_build_object('value', v_step -> 'value') into v_action
    from jsonb_array_elements(v_version.snapshot -> 'actionTypes') a where a ->> 'id' = v_step ->> 'actionTypeId';
    if v_action is null then raise exception 'PENALTY TYPE NOT FOUND'; end if;
    v_levels := array(select jsonb_array_elements_text(v_action -> 'levels'));
    v_amount := public.prosm_time_penalty_amount(p_user, v_action, p_day);

    v_status := case
        when (v_action ->> 'requiresInvestigation')::boolean then 'pending_investigation'
        when (v_action ->> 'requiresResponse')::boolean then 'pending_response'
        when (v_action ->> 'autoApprove')::boolean then 'approved'
        else 'pending_approval' end;

    insert into employee_violations (organization_id, user_id, violation_type_id, bylaw_version_id, rule_snapshot, occurred_on, source, source_ref,
                                     note, evidence_path, reported_by, occurrence_number, suggested, final_action, amount, levels, status,
                                     response_due_at, employee_notified, decided_at)
    values (p_org, p_user, p_type_id, v_version.id,
            jsonb_build_object('version', v_version.version, 'effectiveFrom', v_version.effective_from, 'type', v_type, 'step', v_step,
                               'action', v_action, 'settings', v_version.snapshot -> 'settings'),
            p_day, p_source, p_source_ref, nullif(trim(coalesce(p_note, '')), ''), p_evidence, p_reporter, v_count, v_action, v_action, v_amount,
            v_levels, v_status,
            case when v_status = 'pending_response' then now() + make_interval(days => (v_action ->> 'responseDays')::integer) end,
            v_status in ('pending_response', 'approved'), case when v_status = 'approved' then now() end)
    returning * into v_v;
    v_id := v_v.id;
    v_data := public.prosm_time_violation_note_data(v_v);

    insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note, attachment_path, data)
    values (p_org, v_id, 'recorded', p_reporter, v_v.note, p_evidence,
            jsonb_build_object('source', p_source, 'occurrence', v_count, 'version', v_version.version, 'status', v_status));
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (p_org, p_reporter, p_user, 'hr.violation_recorded', 'employee_violations', v_id, 'Violation recorded',
            jsonb_build_object('occurrence', v_count, 'suggested', v_action, 'status', v_status, 'version', v_version.version));

    if v_status = 'pending_approval' then
        perform public.prosm_time_penalty_notify_level(p_org, p_user, v_levels[1], 'penalty_review', 'A penalty to review',
            coalesce(v_data ->> 'employeeName', '') || ': ' || coalesce(v_data ->> 'violationName', ''), 'employee_violations', v_id, v_data);
    elsif v_status = 'pending_investigation' then
        perform public.prosm_time_penalty_notify_level(p_org, p_user, 'hr', 'penalty_review', 'An investigation is needed',
            coalesce(v_data ->> 'employeeName', '') || ': ' || coalesce(v_data ->> 'violationName', ''), 'employee_violations', v_id,
            v_data || jsonb_build_object('step', 'investigation'));
    elsif v_status = 'pending_response' then
        perform public.create_prosm_time_notification(p_org, p_user, 'penalty_response', 'high', 'Your reply is requested',
            coalesce(v_data ->> 'violationName', ''), 'employee_violations', v_id, v_data || jsonb_build_object('due', v_v.response_due_at));
    else
        perform public.create_prosm_time_notification(p_org, p_user, 'penalty_decided', 'normal', 'A warning',
            coalesce(v_data ->> 'violationName', ''), 'employee_violations', v_id, v_data || jsonb_build_object('result', 'approved'));
    end if;
    return v_id;
end;
$$;
revoke all on function public.prosm_time_create_violation(uuid, uuid, uuid, date, text, text, text, text, uuid) from public, anon, authenticated;

-- cancelling (attendance changed, approved leave or permission, an appeal won, or by hand): money already
-- taken in a closed cycle is settled back in the next one
create or replace function public.prosm_time_cancel_violation(p_id uuid, p_actor uuid, p_reason text, p_step text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_v employee_violations%rowtype;
    v_paid numeric;
begin
    select * into v_v from employee_violations where id = p_id for update;
    if v_v.id is null or v_v.status in ('cancelled', 'rejected', 'lapsed') then return; end if;
    select coalesce(sum(pp.amount), 0) into v_paid
    from penalty_payroll_postings pp join payroll_cycles c on c.id = pp.cycle_id
    where pp.violation_id = p_id and c.status in ('approved', 'locked');
    update employee_violations set status = 'cancelled', decision_note = coalesce(p_reason, decision_note),
           settlement_amount = nullif(v_paid, 0), updated_at = now()
    where id = p_id;
    insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note)
    values (v_v.organization_id, p_id, p_step, p_actor, p_reason);
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_v.organization_id, p_actor, v_v.user_id, 'hr.violation_cancelled', 'employee_violations', p_id, 'Violation cancelled', p_reason);
    if v_v.employee_notified then
        perform public.create_prosm_time_notification(v_v.organization_id, v_v.user_id, 'penalty_appeal_decided', 'normal', 'A penalty was cancelled',
            coalesce(v_v.rule_snapshot #>> '{type,name}', ''), 'employee_violations', p_id,
            public.prosm_time_violation_note_data(v_v) || jsonb_build_object('result', 'cancelled'));
    end if;
    perform public.prosm_time_penalties_refresh_payroll(v_v.user_id);
end;
$$;
revoke all on function public.prosm_time_cancel_violation(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- attendance -> violations (one per type, person and day)
create or replace function public.prosm_time_penalties_evaluate_day(p_user uuid, p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_version bylaw_versions%rowtype;
    v_type jsonb;
    v_summary jsonb;
    v_met boolean;
    v_ref text;
    v_existing employee_violations%rowtype;
    v_made integer := 0;
    v_tz text;
begin
    select organization_id into v_org from users where id = p_user and is_active and coalesce(employment_status, 'active') = 'active';
    if v_org is null or not public.prosm_time_plan_allows(v_org, 'penalties') then return 0; end if;
    v_version := public.prosm_time_bylaw_for(v_org, p_day);
    if v_version.id is null then return 0; end if;
    v_tz := public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user), v_org);
    if p_day >= (now() at time zone v_tz)::date then return 0; end if; -- only finished days
    if p_day < (select created_at from users where id = p_user)::date then return 0; end if;

    for v_type in select x from jsonb_array_elements(v_version.snapshot -> 'violationTypes') x where x ->> 'source' <> 'manual' loop
        v_met := false;
        if v_type ->> 'source' in ('attendance_late', 'attendance_early_leave') then
            if v_summary is null then v_summary := public.prosm_time_day_summary(p_user, p_day); end if;
            v_met := coalesce((v_summary ->> case when v_type ->> 'source' = 'attendance_late' then 'lateMinutes' else 'earlyLeaveMinutes' end)::numeric, 0)
                     > coalesce((v_type ->> 'thresholdMinutes')::numeric, 0);
        elsif v_type ->> 'source' = 'attendance_absent' then
            v_met := public.prosm_time_absent_today(p_user, p_day, v_tz);
        elsif v_type ->> 'source' = 'geofence_exit' then
            v_met := exists (
                select 1 from geofence_exceptions g join exception_actions a on a.geofence_exception_id = g.id and a.action_type = 'rejected'
                where g.user_id = p_user and (g.created_at at time zone v_tz)::date = p_day);
        end if;
        v_ref := 'att:' || (v_type ->> 'id') || ':' || p_user || ':' || p_day;
        select * into v_existing from employee_violations where organization_id = v_org and source_ref = v_ref;
        if v_met and v_existing.id is null then
            perform public.prosm_time_create_violation(v_org, p_user, (v_type ->> 'id')::uuid, p_day, v_type ->> 'source', v_ref, null, null, null);
            v_made := v_made + 1;
        elsif not v_met and v_existing.id is not null and v_existing.status not in ('cancelled', 'rejected', 'lapsed') then
            -- the attendance changed (a correction, an approved leave or permission): the violation goes, never a second one
            perform public.prosm_time_cancel_violation(v_existing.id, null, 'The attendance record changed', 'cancelled_by_attendance');
        end if;
    end loop;
    return v_made;
end;
$$;
revoke all on function public.prosm_time_penalties_evaluate_day(uuid, date) from public, anon, authenticated;

-- a change to a past day is looked at again at once (never blocks the change itself)
create or replace function public.prosm_time_penalties_follow_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user uuid;
    v_from date;
    v_to date;
    v_day date;
begin
    if tg_table_name = 'leave_requests' then
        if tg_op = 'INSERT' then
            if new.status <> 'approved' then return new; end if;
        elsif new.status is not distinct from old.status or new.status not in ('approved', 'cancelled') then
            return new;
        end if;
        v_user := new.user_id; v_from := new.start_date; v_to := least(new.end_date, new.start_date + 62);
    elsif tg_table_name = 'exception_actions' then
        if new.geofence_exception_id is null then return new; end if;
        select g.user_id, g.created_at::date into v_user, v_from from geofence_exceptions g where g.id = new.geofence_exception_id;
        v_to := v_from + 1; v_from := v_from - 1;
    else
        v_user := new.user_id; v_from := new.work_date; v_to := new.work_date;
    end if;
    if v_user is null or not exists (select 1 from bylaw_versions b join users u on u.organization_id = b.organization_id where u.id = v_user) then
        return new;
    end if;
    v_day := v_from;
    while v_day <= v_to loop
        begin
            perform public.prosm_time_penalties_evaluate_day(v_user, v_day);
        exception when others then
            null; -- the nightly pass looks again
        end;
        v_day := v_day + 1;
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_penalties_follow_day() from public, anon, authenticated;

drop trigger if exists penalties_follow_permissions on public.attendance_permissions;
create trigger penalties_follow_permissions after insert or update of status on public.attendance_permissions
for each row when (new.status = 'approved') execute function public.prosm_time_penalties_follow_day();
drop trigger if exists penalties_follow_adjustments on public.attendance_day_adjustments;
create trigger penalties_follow_adjustments after insert on public.attendance_day_adjustments
for each row execute function public.prosm_time_penalties_follow_day();
drop trigger if exists penalties_follow_leave on public.leave_requests;
create trigger penalties_follow_leave after insert or update of status on public.leave_requests
for each row execute function public.prosm_time_penalties_follow_day();
drop trigger if exists penalties_follow_exceptions on public.exception_actions;
create trigger penalties_follow_exceptions after insert on public.exception_actions
for each row execute function public.prosm_time_penalties_follow_day();

-- ---------------------------------------------------------------- the bylaw (settings, types, publishing)
create or replace function public.prosm_time_bylaw_draft(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'settings', (select jsonb_build_object('capUnit', s.cap_unit, 'capDays', s.cap_days, 'capPercent', s.cap_percent,
                                               'maxDaysToImpose', s.max_days_to_impose, 'appealWindowDays', s.appeal_window_days,
                                               'incentiveLevels', to_jsonb(s.incentive_levels))
                     from penalty_settings s where s.organization_id = p_org),
        'actionTypes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'kind', a.kind, 'unit', a.unit,
                                    'requiresInvestigation', a.requires_investigation, 'requiresResponse', a.requires_response, 'responseDays', a.response_days,
                                    'reporterCannotApprove', a.reporter_cannot_approve, 'levels', to_jsonb(a.levels), 'autoApprove', a.auto_approve,
                                    'isBuiltin', a.is_builtin, 'isActive', a.is_active) order by a.sort_order, a.created_at)
                                 from penalty_action_types a where a.organization_id = p_org), '[]'::jsonb),
        'violationTypes', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'templateKey', v.template_key, 'source', v.source,
                                    'thresholdMinutes', v.threshold_minutes, 'lookbackDays', v.lookback_days, 'steps', v.steps, 'isActive', v.is_active)
                                    order by v.created_at)
                                    from violation_types v where v.organization_id = p_org), '[]'::jsonb));
$$;
revoke all on function public.prosm_time_bylaw_draft(uuid) from public, anon, authenticated;

create or replace function public.get_prosm_time_penalty_bylaw()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_s penalty_settings%rowtype;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_penalties_seed(v_org);
    select * into v_s from penalty_settings where organization_id = v_org;
    return public.prosm_time_bylaw_draft(v_org) || jsonb_build_object(
        'liability', jsonb_build_object('at', v_s.liability_acknowledged_at, 'by', (select full_name from users where id = v_s.liability_acknowledged_by)),
        'hasPayroll', public.prosm_time_plan_allows(v_org, 'payroll'),
        'incentiveRules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'templateKey', r.template_key, 'source', r.source,
                                     'amountType', r.amount_type, 'value', r.value, 'isActive', r.is_active) order by r.created_at)
                                     from incentive_rules r where r.organization_id = v_org), '[]'::jsonb),
        'versions', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'version', b.version, 'effectiveFrom', b.effective_from,
                                'resetCounters', b.reset_counters, 'publishedAt', b.published_at,
                                'publishedBy', (select full_name from users where id = b.published_by)) order by b.version desc)
                              from bylaw_versions b where b.organization_id = v_org), '[]'::jsonb),
        'activeVersion', (select b.version from bylaw_versions b where b.organization_id = v_org and b.effective_from <= current_date
                          order by b.effective_from desc, b.version desc limit 1));
end;
$$;
revoke all on function public.get_prosm_time_penalty_bylaw() from public, anon;
grant execute on function public.get_prosm_time_penalty_bylaw() to authenticated;

create or replace function public.save_prosm_time_penalty_settings(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_unit text := nullif(p_data ->> 'capUnit', '');
    v_days numeric := nullif(p_data ->> 'capDays', '')::numeric;
    v_percent numeric := nullif(p_data ->> 'capPercent', '')::numeric;
    v_levels text[] := case when jsonb_typeof(p_data -> 'incentiveLevels') = 'array' then array(select jsonb_array_elements_text(p_data -> 'incentiveLevels'))
                            else coalesce((select incentive_levels from penalty_settings where organization_id = public.current_prosm_time_organization_id()), array['hr']) end;
    v_old jsonb;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_penalties_seed(v_org);
    if v_unit is not null and v_unit not in ('days_per_month', 'percent_of_wage', 'both') then raise exception 'INVALID DEDUCTION CAP'; end if;
    if v_unit in ('days_per_month', 'both') and (v_days is null or v_days <= 0) then raise exception 'ENTER THE DEDUCTION CAP IN DAYS'; end if;
    if v_unit in ('percent_of_wage', 'both') and (v_percent is null or v_percent <= 0 or v_percent > 100) then raise exception 'ENTER THE DEDUCTION CAP AS A PERCENTAGE'; end if;
    if cardinality(v_levels) not between 1 and 3 or not v_levels <@ array['manager', 'hr', 'owner'] then raise exception 'INVALID APPROVAL LEVELS'; end if;
    if exists (select 1 from bylaw_versions where organization_id = v_org) then
        if v_unit is null then raise exception 'SET THE DEDUCTION CAP FIRST'; end if;
        if nullif(p_data ->> 'appealWindowDays', '') is null then raise exception 'SET THE APPEAL WINDOW FIRST'; end if;
    end if;
    select to_jsonb(s) into v_old from penalty_settings s where s.organization_id = v_org;
    update penalty_settings set
        cap_unit = v_unit,
        cap_days = case when v_unit in ('days_per_month', 'both') then v_days end,
        cap_percent = case when v_unit in ('percent_of_wage', 'both') then v_percent end,
        max_days_to_impose = nullif(p_data ->> 'maxDaysToImpose', '')::integer,
        appeal_window_days = nullif(p_data ->> 'appealWindowDays', '')::integer,
        incentive_levels = v_levels,
        liability_acknowledged_by = case when coalesce((p_data ->> 'acknowledgeLiability')::boolean, false) then v_me else liability_acknowledged_by end,
        liability_acknowledged_at = case when coalesce((p_data ->> 'acknowledgeLiability')::boolean, false) then now() else liability_acknowledged_at end,
        updated_by = v_me, updated_at = now()
    where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, previous_state, new_state)
    values (v_org, v_me, 'hr.penalty_settings_saved', 'penalty_settings', 'Penalty bylaw settings saved', v_old, p_data);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.save_prosm_time_penalty_settings(jsonb) from public, anon;
grant execute on function public.save_prosm_time_penalty_settings(jsonb) to authenticated;

create or replace function public.save_prosm_time_penalty_action_type(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_levels text[] := array(select jsonb_array_elements_text(coalesce(p_data -> 'levels', '["manager"]'::jsonb)));
    v_kind text := coalesce(p_data ->> 'kind', 'other');
    v_unit text := nullif(p_data ->> 'unit', '');
    v_name text := nullif(trim(coalesce(p_data ->> 'name', '')), '');
    v_id uuid := p_id;
    v_builtin boolean;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    if cardinality(v_levels) not between 1 and 3 or not v_levels <@ array['manager', 'hr', 'owner'] then raise exception 'CHOOSE WHO APPROVES'; end if;
    if coalesce((p_data ->> 'requiresResponse')::boolean, false) and coalesce(nullif(p_data ->> 'responseDays', '')::integer, 0) < 1 then
        raise exception 'ENTER THE DAYS TO REPLY';
    end if;
    if p_id is null then
        if v_name is null then raise exception 'A NAME IS REQUIRED'; end if;
        if v_kind not in ('warning', 'deduction', 'suspension', 'investigation', 'other') then raise exception 'INVALID PENALTY KIND'; end if;
        if v_kind = 'deduction' and v_unit not in ('days', 'hours', 'amount') then raise exception 'CHOOSE THE DEDUCTION UNIT'; end if;
        insert into penalty_action_types (organization_id, code, name, kind, unit, sort_order)
        values (v_org, 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) , v_name, v_kind,
                case when v_kind = 'deduction' then v_unit when v_kind = 'suspension' then 'days' end, 200)
        returning id into v_id;
    else
        select is_builtin into v_builtin from penalty_action_types where id = p_id and organization_id = v_org;
        if v_builtin is null then raise exception 'NOT FOUND'; end if;
        if not v_builtin and v_name is null then raise exception 'A NAME IS REQUIRED'; end if;
        update penalty_action_types set name = case when is_builtin then v_name else coalesce(v_name, name) end where id = p_id;
    end if;
    update penalty_action_types set
        requires_investigation = coalesce((p_data ->> 'requiresInvestigation')::boolean, false),
        requires_response = coalesce((p_data ->> 'requiresResponse')::boolean, false),
        response_days = nullif(p_data ->> 'responseDays', '')::integer,
        reporter_cannot_approve = coalesce((p_data ->> 'reporterCannotApprove')::boolean, true),
        levels = v_levels,
        auto_approve = coalesce((p_data ->> 'autoApprove')::boolean, false) and kind = 'warning'
                       and not coalesce((p_data ->> 'requiresInvestigation')::boolean, false) and not coalesce((p_data ->> 'requiresResponse')::boolean, false),
        is_active = coalesce((p_data ->> 'isActive')::boolean, true),
        updated_at = now()
    where id = v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_me, 'hr.penalty_type_saved', 'penalty_action_types', v_id, 'Penalty type saved', p_data);
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_penalty_action_type(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_penalty_action_type(uuid, jsonb) to authenticated;

create or replace function public.save_prosm_time_violation_type(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_name text := nullif(trim(coalesce(p_data ->> 'name', '')), '');
    v_source text := coalesce(p_data ->> 'source', 'manual');
    v_steps jsonb := coalesce(p_data -> 'steps', '[]'::jsonb);
    v_step jsonb;
    v_kind text;
    v_clean jsonb := '[]'::jsonb;
    v_id uuid := p_id;
    v_template text;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    if p_id is not null then
        select template_key into v_template from violation_types where id = p_id and organization_id = v_org;
        if not found then raise exception 'NOT FOUND'; end if;
    end if;
    if v_name is null and v_template is null then raise exception 'A NAME IS REQUIRED'; end if;
    if v_source not in ('attendance_late', 'attendance_early_leave', 'attendance_absent', 'geofence_exit', 'manual') then raise exception 'INVALID VIOLATION SOURCE'; end if;
    if v_source in ('attendance_late', 'attendance_early_leave') and nullif(p_data ->> 'thresholdMinutes', '') is null then
        raise exception 'ENTER THE MINUTES THAT MAKE IT A VIOLATION';
    end if;
    if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) = 0 then raise exception 'ADD AT LEAST ONE PENALTY STEP'; end if;
    for v_step in select s from jsonb_array_elements(v_steps) s order by (s ->> 'occurrence')::integer loop
        if coalesce((v_step ->> 'occurrence')::integer, 0) < 1 or (v_step ->> 'occurrence')::integer > 50 then raise exception 'INVALID OCCURRENCE NUMBER'; end if;
        if exists (select 1 from jsonb_array_elements(v_clean) c where c ->> 'occurrence' = v_step ->> 'occurrence') then raise exception 'EACH OCCURRENCE ONCE'; end if;
        select kind into v_kind from penalty_action_types where id = (v_step ->> 'actionTypeId')::uuid and organization_id = v_org and is_active;
        if v_kind is null then raise exception 'PENALTY TYPE NOT FOUND'; end if;
        if v_kind in ('deduction', 'suspension') and coalesce(nullif(v_step ->> 'value', '')::numeric, 0) <= 0 then raise exception 'ENTER THE PENALTY VALUE'; end if;
        v_clean := v_clean || jsonb_build_array(jsonb_build_object('occurrence', (v_step ->> 'occurrence')::integer, 'actionTypeId', v_step ->> 'actionTypeId',
                                                                   'value', case when v_kind in ('deduction', 'suspension') then (v_step ->> 'value')::numeric end));
    end loop;
    if p_id is null then
        insert into violation_types (organization_id, name, source) values (v_org, v_name, v_source) returning id into v_id;
    end if;
    update violation_types set
        name = coalesce(v_name, name), source = v_source,
        threshold_minutes = case when v_source in ('attendance_late', 'attendance_early_leave') then (p_data ->> 'thresholdMinutes')::integer end,
        lookback_days = coalesce(nullif(p_data ->> 'lookbackDays', '')::integer, lookback_days),
        steps = v_clean, is_active = coalesce((p_data ->> 'isActive')::boolean, is_active), updated_at = now()
    where id = v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_me, 'hr.violation_type_saved', 'violation_types', v_id, 'Violation saved (draft until published)', p_data);
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_violation_type(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_violation_type(uuid, jsonb) to authenticated;

-- the suggested list: common names and a sample ladder, added stopped (never a cap, never switched on)
create or replace function public.add_prosm_time_penalty_template()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_ww uuid;
    v_days uuid;
    v_added integer := 0;
    v_t record;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_penalties_seed(v_org);
    select id into v_ww from penalty_action_types where organization_id = v_org and code = 'written_warning';
    select id into v_days from penalty_action_types where organization_id = v_org and code = 'deduct_days';
    for v_t in
        select * from (values
            ('late_arrival', 'attendance_late', 15),
            ('early_leave', 'attendance_early_leave', 15),
            ('absence', 'attendance_absent', null),
            ('left_work_area', 'geofence_exit', null),
            ('phone_use', 'manual', null),
            ('safety_equipment', 'manual', null),
            ('uniform', 'manual', null)
        ) as x(key, source, minutes)
    loop
        continue when exists (select 1 from violation_types where organization_id = v_org and template_key = v_t.key);
        insert into violation_types (organization_id, template_key, source, threshold_minutes, steps, is_active)
        values (v_org, v_t.key, v_t.source, v_t.minutes, jsonb_build_array(
            jsonb_build_object('occurrence', 1, 'actionTypeId', v_ww, 'value', null),
            jsonb_build_object('occurrence', 2, 'actionTypeId', v_days, 'value', 0.25),
            jsonb_build_object('occurrence', 3, 'actionTypeId', v_days, 'value', 0.5),
            jsonb_build_object('occurrence', 4, 'actionTypeId', v_days, 'value', 1)), false);
        v_added := v_added + 1;
    end loop;
    if not exists (select 1 from incentive_rules where organization_id = v_org and template_key = 'no_late_month') then
        insert into incentive_rules (organization_id, template_key, source, amount_type, value, is_active)
        values (v_org, 'no_late_month', 'no_late_month', 'days', 1, false), (v_org, 'full_attendance_month', 'full_attendance_month', 'days', 1, false);
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.penalty_template_added', 'violation_types', 'Suggested violations added as drafts',
            jsonb_build_object('added', v_added));
    return jsonb_build_object('added', v_added);
end;
$$;
revoke all on function public.add_prosm_time_penalty_template() from public, anon;
grant execute on function public.add_prosm_time_penalty_template() to authenticated;

create or replace function public.save_prosm_time_incentive_rule(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid := p_id;
    v_type text := coalesce(p_data ->> 'amountType', 'amount');
    v_value numeric := nullif(p_data ->> 'value', '')::numeric;
    v_name text := nullif(trim(coalesce(p_data ->> 'name', '')), '');
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    if v_type not in ('amount', 'days', 'percent') then raise exception 'INVALID INCENTIVE'; end if;
    if v_value is null or v_value <= 0 or (v_type = 'percent' and v_value > 100) then raise exception 'ENTER THE INCENTIVE VALUE'; end if;
    if p_id is null then
        if v_name is null then raise exception 'A NAME IS REQUIRED'; end if;
        if coalesce(p_data ->> 'source', '') not in ('no_late_month', 'full_attendance_month') then raise exception 'INVALID INCENTIVE'; end if;
        insert into incentive_rules (organization_id, name, source, amount_type, value)
        values (v_org, v_name, p_data ->> 'source', v_type, v_value) returning id into v_id;
    elsif not exists (select 1 from incentive_rules where id = p_id and organization_id = v_org) then
        raise exception 'NOT FOUND';
    end if;
    update incentive_rules set name = coalesce(v_name, name), amount_type = v_type, value = v_value,
           is_active = coalesce((p_data ->> 'isActive')::boolean, is_active), updated_at = now()
    where id = v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'hr.incentive_rule_saved', 'incentive_rules', v_id, 'Incentive rule saved', p_data);
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.save_prosm_time_incentive_rule(uuid, jsonb) from public, anon;
grant execute on function public.save_prosm_time_incentive_rule(uuid, jsonb) to authenticated;

-- publishing: a new immutable version from a date; the first one needs the cap, the appeal window and the
-- liability acknowledgement; it is posted in the Media Center for everyone to confirm reading
create or replace function public.publish_prosm_time_penalty_bylaw(p_effective_from date, p_reset_counters boolean, p_announcement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_s penalty_settings%rowtype;
    v_draft jsonb;
    v_types jsonb;
    v_version integer;
    v_id uuid;
    v_ann uuid;
    v_tz text;
begin
    perform public.prosm_time_require_feature('penalties');
    if not public.prosm_time_penalties_admin() then raise exception 'PERMISSION DENIED'; end if;
    perform public.prosm_time_penalties_seed(v_org);
    select * into v_s from penalty_settings where organization_id = v_org;
    if v_s.cap_unit is null then raise exception 'SET THE DEDUCTION CAP FIRST'; end if;
    if v_s.appeal_window_days is null then raise exception 'SET THE APPEAL WINDOW FIRST'; end if;
    if v_s.liability_acknowledged_at is null then raise exception 'ACKNOWLEDGE THE LIABILITY NOTICE FIRST'; end if;
    v_tz := public.prosm_time_site_timezone(null, v_org);
    if p_effective_from is null or p_effective_from < (now() at time zone v_tz)::date then raise exception 'THE START DATE CANNOT BE IN THE PAST'; end if;
    v_draft := public.prosm_time_bylaw_draft(v_org);
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_types from jsonb_array_elements(v_draft -> 'violationTypes') x where (x ->> 'isActive')::boolean;
    if jsonb_array_length(v_types) = 0 then raise exception 'TURN ON AT LEAST ONE VIOLATION'; end if;
    -- every step's penalty type must still be on
    if exists (select 1 from jsonb_array_elements(v_types) t, jsonb_array_elements(t -> 'steps') s
               where not exists (select 1 from penalty_action_types a where a.id = (s ->> 'actionTypeId')::uuid and a.is_active)) then
        raise exception 'A STEP USES A PENALTY TYPE THAT IS OFF';
    end if;
    select coalesce(max(version), 0) + 1 into v_version from bylaw_versions where organization_id = v_org;
    insert into bylaw_versions (organization_id, version, effective_from, reset_counters, snapshot, published_by)
    values (v_org, v_version, p_effective_from, coalesce(p_reset_counters, false),
            jsonb_build_object('settings', v_draft -> 'settings', 'violationTypes', v_types,
                               'actionTypes', (select coalesce(jsonb_agg(a), '[]'::jsonb) from jsonb_array_elements(v_draft -> 'actionTypes') a where (a ->> 'isActive')::boolean)),
            v_me)
    returning id into v_id;

    -- the Media Center: everyone reads it and confirms (the text is written by the app in the publisher's language)
    if public.prosm_time_plan_allows(v_org, 'announcements') and length(trim(coalesce(p_announcement ->> 'title', ''))) > 0 then
        insert into announcements (organization_id, kind, title, body, audience_type, requires_ack, created_by, updated_by)
        values (v_org, 'statement', left(trim(p_announcement ->> 'title'), 200), left(coalesce(p_announcement ->> 'body', ''), 20000), 'all', true, v_me, v_me)
        returning id into v_ann;
        perform public.prosm_time_publish_announcement_now(v_ann, v_me);
        update bylaw_versions set announcement_id = v_ann where id = v_id;
    end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_me, 'hr.bylaw_published', 'bylaw_versions', v_id, 'Penalty bylaw published',
            jsonb_build_object('version', v_version, 'effectiveFrom', p_effective_from, 'resetCounters', coalesce(p_reset_counters, false)));
    return jsonb_build_object('id', v_id, 'version', v_version, 'announcementId', v_ann);
end;
$$;
revoke all on function public.publish_prosm_time_penalty_bylaw(date, boolean, jsonb) from public, anon;
grant execute on function public.publish_prosm_time_penalty_bylaw(date, boolean, jsonb) to authenticated;

-- ---------------------------------------------------------------- recording by hand
create or replace function public.record_prosm_time_violation(p_user_id uuid, p_type_id uuid, p_day date, p_note text, p_evidence text, p_client_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_id uuid;
    v_tz text;
begin
    perform public.prosm_time_require_feature('penalties');
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then raise exception 'NOT FOUND'; end if;
    if p_user_id = v_me or not (public.prosm_time_caller_has_authority_over(p_user_id) or public.prosm_time_is_hr()) then raise exception 'PERMISSION DENIED'; end if;
    v_tz := public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user_id), v_org);
    if p_day is null or p_day > (now() at time zone v_tz)::date then raise exception 'THE DATE CANNOT BE IN THE FUTURE'; end if;
    if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'DESCRIBE WHAT HAPPENED'; end if;
    if p_evidence is not null and p_evidence not like v_org || '/evidence/' || p_user_id || '/%' then raise exception 'INVALID FILE'; end if;
    if not exists (select 1 from jsonb_array_elements((public.prosm_time_bylaw_for(v_org, p_day)).snapshot -> 'violationTypes') x
                   where x ->> 'id' = p_type_id::text and x ->> 'source' = 'manual') then
        if (public.prosm_time_bylaw_for(v_org, p_day)).id is null then raise exception 'THE PENALTY BYLAW IS NOT ACTIVE'; end if;
        raise exception 'THIS VIOLATION IS NOT IN THE BYLAW IN FORCE ON THAT DAY';
    end if;
    v_id := public.prosm_time_create_violation(v_org, p_user_id, p_type_id, p_day, 'manual',
                                               case when p_client_ref is not null then 'manual:' || p_client_ref end, p_note, p_evidence, v_me);
    return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.record_prosm_time_violation(uuid, uuid, date, text, text, text) from public, anon;
grant execute on function public.record_prosm_time_violation(uuid, uuid, date, text, text, text) to authenticated;

-- ---------------------------------------------------------------- the workflow
-- what the reader may do now with this violation
create or replace function public.prosm_time_violation_actions(v employee_violations)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_self boolean := v.user_id = v_me;
    v_hr boolean := public.prosm_time_is_hr();
    v_level text := v.levels[v.current_level + 1];
    v_can_level boolean;
    v_window integer := nullif(v.rule_snapshot #>> '{settings,appealWindowDays}', '')::integer;
    v_out text[] := '{}';
begin
    v_can_level := v_level is not null and public.prosm_time_penalty_can_act_level(v.user_id, v_level)
                   and (public.current_prosm_time_user_is_real_owner() or not exists (
                        select 1 from employee_violation_steps st where st.violation_id = v.id and st.actor_id = v_me and st.step_type in ('approval', 'reduced')))
                   and not (coalesce((v.rule_snapshot #>> '{action,reporterCannotApprove}')::boolean, true) and v.reported_by = v_me
                            and not public.current_prosm_time_user_is_real_owner());
    if v.status = 'pending_investigation' then
        if not v_self and (v_hr or v_can_level) then v_out := v_out || array['investigate']; end if;
    elsif v.status = 'pending_response' then
        if v_self then v_out := v_out || array['respond']; end if;
        if v.response_due_at < now() and v_can_level then v_out := v_out || array['approve', 'reduce', 'reject']; end if;
    elsif v.status = 'pending_approval' then
        if v_can_level then v_out := v_out || array['approve', 'reduce', 'reject']; end if;
    elsif v.status in ('approved', 'reduced') then
        if v_self and v.acknowledged_at is null then v_out := v_out || array['acknowledge']; end if;
        if v_self and v.appealed_at is null and v_window is not null and v.decided_at + make_interval(days => v_window) >= now() then
            v_out := v_out || array['appeal'];
        end if;
        if not v_self and v.acknowledged_at is null and v.refused_ack_at is null and (v_hr or public.prosm_time_caller_has_authority_over(v.user_id)) then
            v_out := v_out || array['refused_ack'];
        end if;
    elsif v.status = 'appealed' then
        if not v_self and (public.current_prosm_time_user_is_owner() or (v_hr and v.decided_by is distinct from v_me)) then
            v_out := v_out || array['appeal_confirm', 'appeal_cancel'];
        end if;
    end if;
    if not v_self and v_hr and v.status not in ('cancelled', 'rejected', 'lapsed', 'appealed') then v_out := v_out || array['cancel']; end if;
    return v_out;
end;
$$;
revoke all on function public.prosm_time_violation_actions(employee_violations) from public, anon, authenticated;

create or replace function public.act_prosm_time_violation(p_id uuid, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_v employee_violations%rowtype;
    v_note text := nullif(trim(coalesce(p_data ->> 'note', '')), '');
    v_action jsonb;
    v_levels text[];
    v_next text;
    v_data jsonb;
    v_status text;
begin
    perform public.prosm_time_require_feature('penalties');
    select * into v_v from employee_violations where id = p_id and organization_id = v_org for update;
    if v_v.id is null then raise exception 'NOT FOUND'; end if;
    if not (p_action = any(public.prosm_time_violation_actions(v_v))) then
        raise exception 'THIS STEP IS NOT AVAILABLE NOW';
    end if;

    if p_action = 'investigate' then
        if v_note is null then raise exception 'WRITE THE INVESTIGATION REPORT'; end if;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note, attachment_path)
        values (v_org, p_id, 'investigation', v_me, v_note, nullif(p_data ->> 'attachment', ''));
        if (v_v.rule_snapshot #>> '{action,requiresResponse}')::boolean then
            update employee_violations set status = 'pending_response', employee_notified = true, updated_at = now(),
                   response_due_at = now() + make_interval(days => (v_v.rule_snapshot #>> '{action,responseDays}')::integer)
            where id = p_id returning * into v_v;
            perform public.create_prosm_time_notification(v_org, v_v.user_id, 'penalty_response', 'high', 'Your reply is requested',
                coalesce(v_v.rule_snapshot #>> '{type,name}', ''), 'employee_violations', p_id,
                public.prosm_time_violation_note_data(v_v) || jsonb_build_object('due', v_v.response_due_at));
        else
            update employee_violations set status = 'pending_approval', updated_at = now() where id = p_id returning * into v_v;
            v_data := public.prosm_time_violation_note_data(v_v);
            perform public.prosm_time_penalty_notify_level(v_org, v_v.user_id, v_v.levels[1], 'penalty_review', 'A penalty to review',
                coalesce(v_data ->> 'employeeName', ''), 'employee_violations', p_id, v_data);
        end if;
    elsif p_action = 'respond' then
        if v_note is null then raise exception 'WRITE YOUR REPLY'; end if;
        update employee_violations set status = 'pending_approval', employee_response = v_note, updated_at = now() where id = p_id returning * into v_v;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note) values (v_org, p_id, 'employee_response', v_me, v_note);
        v_data := public.prosm_time_violation_note_data(v_v);
        perform public.prosm_time_penalty_notify_level(v_org, v_v.user_id, v_v.levels[1], 'penalty_review', 'A penalty to review',
            coalesce(v_data ->> 'employeeName', ''), 'employee_violations', p_id, v_data || jsonb_build_object('step', 'replied'));
    elsif p_action in ('approve', 'reduce') then
        if p_action = 'reduce' then
            select a || jsonb_build_object('value', nullif(p_data ->> 'value', '')::numeric) into v_action
            from bylaw_versions b, jsonb_array_elements(b.snapshot -> 'actionTypes') a
            where b.id = v_v.bylaw_version_id and a ->> 'id' = p_data ->> 'actionTypeId';
            if v_action is null then raise exception 'PENALTY TYPE NOT FOUND'; end if;
            if v_action ->> 'kind' in ('deduction', 'suspension') and coalesce((v_action ->> 'value')::numeric, 0) <= 0 then raise exception 'ENTER THE PENALTY VALUE'; end if;
            if not (v_action ->> 'kind' = 'warning'
                    or (v_action ->> 'kind' = v_v.final_action ->> 'kind' and coalesce(v_action ->> 'unit', '') = coalesce(v_v.final_action ->> 'unit', '')
                        and coalesce((v_action ->> 'value')::numeric, 0) <= coalesce((v_v.final_action ->> 'value')::numeric, 0))) then
                raise exception 'A REDUCTION MUST BE LIGHTER';
            end if;
            if v_action ->> 'kind' not in ('deduction', 'suspension') then v_action := v_action || jsonb_build_object('value', null); end if;
            if v_note is null then raise exception 'A REASON IS REQUIRED'; end if;
            update employee_violations set final_action = v_action,
                   amount = public.prosm_time_penalty_amount(v_v.user_id, v_action, v_v.occurred_on), updated_at = now()
            where id = p_id returning * into v_v;
        end if;
        insert into employee_violation_steps (organization_id, violation_id, step_type, level_order, actor_id, note, data)
        values (v_org, p_id, case when p_action = 'reduce' then 'reduced' else 'approval' end, v_v.current_level + 1, v_me, v_note,
                case when p_action = 'reduce' then jsonb_build_object('action', v_action) end);
        if v_v.current_level + 1 < cardinality(v_v.levels) then
            update employee_violations set current_level = current_level + 1, status = 'pending_approval', updated_at = now()
            where id = p_id returning * into v_v;
            v_next := v_v.levels[v_v.current_level + 1];
            v_data := public.prosm_time_violation_note_data(v_v);
            perform public.prosm_time_penalty_notify_level(v_org, v_v.user_id, v_next, 'penalty_review', 'A penalty to review',
                coalesce(v_data ->> 'employeeName', ''), 'employee_violations', p_id, v_data);
        else
            v_status := case when v_v.final_action = v_v.suggested then 'approved' else 'reduced' end;
            update employee_violations set status = v_status, decided_by = v_me, decided_at = now(), decision_note = coalesce(v_note, decision_note),
                   employee_notified = true, updated_at = now()
            where id = p_id returning * into v_v;
            perform public.create_prosm_time_notification(v_org, v_v.user_id, 'penalty_decided', 'high', 'A penalty decision',
                coalesce(v_v.rule_snapshot #>> '{type,name}', ''), 'employee_violations', p_id,
                public.prosm_time_violation_note_data(v_v) || jsonb_build_object('result', v_status,
                    'appealUntil', v_v.decided_at + make_interval(days => coalesce(nullif(v_v.rule_snapshot #>> '{settings,appealWindowDays}', '')::integer, 0))));
            perform public.prosm_time_penalties_refresh_payroll(v_v.user_id);
        end if;
    elsif p_action = 'reject' then
        if v_note is null then raise exception 'A REASON IS REQUIRED TO REJECT'; end if;
        update employee_violations set status = 'rejected', decided_by = v_me, decided_at = now(), decision_note = v_note, updated_at = now()
        where id = p_id returning * into v_v;
        insert into employee_violation_steps (organization_id, violation_id, step_type, level_order, actor_id, note)
        values (v_org, p_id, 'rejected', v_v.current_level + 1, v_me, v_note);
        if v_v.employee_notified then
            perform public.create_prosm_time_notification(v_org, v_v.user_id, 'penalty_decided', 'normal', 'A penalty decision',
                coalesce(v_v.rule_snapshot #>> '{type,name}', ''), 'employee_violations', p_id,
                public.prosm_time_violation_note_data(v_v) || jsonb_build_object('result', 'rejected'));
        end if;
    elsif p_action = 'acknowledge' then
        update employee_violations set acknowledged_at = now(), updated_at = now() where id = p_id;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id) values (v_org, p_id, 'acknowledged', v_me);
    elsif p_action = 'refused_ack' then
        if length(trim(coalesce(p_data ->> 'witness', ''))) = 0 then raise exception 'ENTER THE WITNESS NAME'; end if;
        update employee_violations set refused_ack_at = now(), refused_ack_witness = trim(p_data ->> 'witness'), updated_at = now() where id = p_id;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note, data)
        values (v_org, p_id, 'refused_ack', v_me, v_note, jsonb_build_object('witness', trim(p_data ->> 'witness')));
    elsif p_action = 'appeal' then
        if v_note is null then raise exception 'WRITE THE REASON FOR THE APPEAL'; end if;
        update employee_violations set status = 'appealed', status_before_appeal = status, appeal_text = v_note, appealed_at = now(), updated_at = now()
        where id = p_id returning * into v_v;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note) values (v_org, p_id, 'appeal', v_me, v_note);
        perform public.prosm_time_penalties_refresh_payroll(v_v.user_id);
        v_data := public.prosm_time_violation_note_data(v_v);
        perform public.prosm_time_penalty_notify_level(v_org, v_v.user_id, 'hr', 'penalty_appeal', 'An appeal', coalesce(v_data ->> 'employeeName', ''),
            'employee_violations', p_id, v_data);
        perform public.prosm_time_penalty_notify_level(v_org, v_v.user_id, 'owner', 'penalty_appeal', 'An appeal', coalesce(v_data ->> 'employeeName', ''),
            'employee_violations', p_id, v_data);
    elsif p_action = 'appeal_confirm' then
        update employee_violations set status = status_before_appeal, appeal_decided_by = v_me, appeal_decided_at = now(), updated_at = now()
        where id = p_id returning * into v_v;
        insert into employee_violation_steps (organization_id, violation_id, step_type, actor_id, note) values (v_org, p_id, 'appeal_confirmed', v_me, v_note);
        perform public.prosm_time_penalties_refresh_payroll(v_v.user_id);
        perform public.create_prosm_time_notification(v_org, v_v.user_id, 'penalty_appeal_decided', 'normal', 'Your appeal was decided',
            coalesce(v_v.rule_snapshot #>> '{type,name}', ''), 'employee_violations', p_id,
            public.prosm_time_violation_note_data(v_v) || jsonb_build_object('result', 'confirmed'));
    elsif p_action = 'appeal_cancel' then
        update employee_violations set appeal_decided_by = v_me, appeal_decided_at = now() where id = p_id;
        perform public.prosm_time_cancel_violation(p_id, v_me, coalesce(v_note, 'Appeal accepted'), 'appeal_accepted');
    elsif p_action = 'cancel' then
        if v_note is null then raise exception 'A REASON IS REQUIRED'; end if;
        perform public.prosm_time_cancel_violation(p_id, v_me, v_note, 'cancelled');
    end if;

    if p_action not in ('appeal_cancel', 'cancel') then
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, new_state)
        values (v_org, v_me, v_v.user_id, 'hr.violation_' || p_action, 'employee_violations', p_id, 'Violation: ' || p_action, v_note,
                jsonb_build_object('status', (select status from employee_violations where id = p_id), 'finalAction', v_v.final_action));
    end if;
    return jsonb_build_object('success', true, 'status', (select status from employee_violations where id = p_id));
end;
$$;
revoke all on function public.act_prosm_time_violation(uuid, text, jsonb) from public, anon;
grant execute on function public.act_prosm_time_violation(uuid, text, jsonb) to authenticated;

-- one row for the screens
create or replace function public.prosm_time_violation_row(v employee_violations, p_steps boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'id', v.id, 'userId', v.user_id, 'name', u.full_name, 'avatarUrl', u.avatar_url,
        'violationName', v.rule_snapshot #>> '{type,name}', 'templateKey', v.rule_snapshot #>> '{type,templateKey}',
        'source', v.source, 'occurredOn', v.occurred_on, 'occurrence', v.occurrence_number,
        'suggested', v.suggested, 'finalAction', v.final_action,
        'amount', case when v.user_id = public.current_prosm_time_user_id() or public.prosm_time_is_hr() then v.amount end,
        'status', v.status, 'levels', to_jsonb(v.levels), 'currentLevel', v.current_level,
        'note', v.note, 'evidencePath', v.evidence_path, 'responseDueAt', v.response_due_at, 'employeeResponse', v.employee_response,
        'decidedAt', v.decided_at, 'decidedBy', (select full_name from users where id = v.decided_by), 'decisionNote', v.decision_note,
        'acknowledgedAt', v.acknowledged_at, 'refusedAckAt', v.refused_ack_at, 'refusedAckWitness', v.refused_ack_witness,
        'appealText', v.appeal_text, 'appealedAt', v.appealed_at,
        'appealUntil', case when v.decided_at is not null and (v.rule_snapshot #>> '{settings,appealWindowDays}') is not null
                            then v.decided_at + make_interval(days => (v.rule_snapshot #>> '{settings,appealWindowDays}')::integer) end,
        'version', (v.rule_snapshot ->> 'version')::integer, 'versionFrom', v.rule_snapshot ->> 'effectiveFrom',
        'reportedBy', (select full_name from users where id = v.reported_by),
        'posted', case when v.user_id = public.current_prosm_time_user_id() or public.prosm_time_is_hr()
                       then (select coalesce(sum(pp.amount), 0) from penalty_payroll_postings pp join payroll_cycles c on c.id = pp.cycle_id
                             where pp.violation_id = v.id and c.status <> 'cancelled') else 0 end,
        'settlement', case when v.user_id = public.current_prosm_time_user_id() or public.prosm_time_is_hr() then v.settlement_amount end,
        'actions', to_jsonb(public.prosm_time_violation_actions(v)),
        'steps', case when p_steps then coalesce((select jsonb_agg(jsonb_build_object('type', s.step_type, 'level', s.level_order, 'at', s.created_at,
                                         'by', (select full_name from users where id = s.actor_id), 'note', s.note, 'attachment', s.attachment_path, 'data', s.data)
                                         order by s.created_at) from employee_violation_steps s where s.violation_id = v.id), '[]'::jsonb) end)
    from users u where u.id = v.user_id;
$$;
revoke all on function public.prosm_time_violation_row(employee_violations, boolean) from public, anon, authenticated;

-- may the reader see this person's penalties (themself only once they were told)
create or replace function public.prosm_time_penalty_visible(v employee_violations)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case
        when v.user_id = public.current_prosm_time_user_id() then v.employee_notified
        else public.prosm_time_is_hr() or public.prosm_time_caller_has_authority_over(v.user_id)
    end;
$$;
revoke all on function public.prosm_time_penalty_visible(employee_violations) from public, anon, authenticated;

create or replace function public.list_prosm_time_violations(p_user_id uuid default null, p_status text default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    perform public.prosm_time_require_feature('penalties');
    return coalesce((
        select jsonb_agg(public.prosm_time_violation_row(x.v, false) order by (x.v).occurred_on desc, (x.v).created_at desc)
        from (
            select v from employee_violations v
            where v.organization_id = v_org and (p_user_id is null or v.user_id = p_user_id)
              and (p_status is null or v.status = p_status
                   or (p_status = 'open' and v.status in ('pending_investigation', 'pending_response', 'pending_approval', 'appealed')))
              and public.prosm_time_penalty_visible(v)
            order by v.occurred_on desc, v.created_at desc
            limit least(greatest(coalesce(p_limit, 300), 1), 1000)
        ) x), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_violations(uuid, text, integer) from public, anon;
grant execute on function public.list_prosm_time_violations(uuid, text, integer) to authenticated;

create or replace function public.get_prosm_time_violation(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_v employee_violations%rowtype;
begin
    perform public.prosm_time_require_feature('penalties');
    select * into v_v from employee_violations where id = p_id and organization_id = public.current_prosm_time_organization_id();
    if v_v.id is null or not public.prosm_time_penalty_visible(v_v) then raise exception 'NOT FOUND'; end if;
    return public.prosm_time_violation_row(v_v, true)
        || jsonb_build_object('reduceOptions', (select coalesce(jsonb_agg(a), '[]'::jsonb) from bylaw_versions b, jsonb_array_elements(b.snapshot -> 'actionTypes') a
                                                where b.id = v_v.bylaw_version_id));
end;
$$;
revoke all on function public.get_prosm_time_violation(uuid) from public, anon;
grant execute on function public.get_prosm_time_violation(uuid) to authenticated;

-- the manual violations the reader may record (from the bylaw in force today)
create or replace function public.list_prosm_time_manual_violations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_b bylaw_versions%rowtype;
begin
    perform public.prosm_time_require_feature('penalties');
    v_b := public.prosm_time_bylaw_for(v_org, (now() at time zone public.prosm_time_site_timezone(null, v_org))::date);
    if v_b.id is null then return jsonb_build_object('active', false, 'types', '[]'::jsonb); end if;
    return jsonb_build_object('active', true, 'version', v_b.version,
        'types', (select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'name', x ->> 'name', 'templateKey', x ->> 'templateKey')), '[]'::jsonb)
                  from jsonb_array_elements(v_b.snapshot -> 'violationTypes') x where x ->> 'source' = 'manual'));
end;
$$;
revoke all on function public.list_prosm_time_manual_violations() from public, anon;
grant execute on function public.list_prosm_time_manual_violations() to authenticated;

-- ---------------------------------------------------------------- incentives
create or replace function public.prosm_time_incentive_amount(p_user uuid, p_type text, p_value numeric, p_day date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_wage numeric;
begin
    if not public.prosm_time_plan_allows((select organization_id from users where id = p_user), 'payroll') then return null; end if;
    if p_type = 'amount' then return round(p_value, 2); end if;
    v_wage := public.prosm_time_day_wage(p_user, p_day);
    if v_wage is null then return null; end if;
    if p_type = 'days' then return round(p_value * v_wage, 2); end if;
    return round(p_value / 100 * v_wage * (select day_divisor from payroll_settings s join users u on u.organization_id = s.organization_id where u.id = p_user), 2);
end;
$$;
revoke all on function public.prosm_time_incentive_amount(uuid, text, numeric, date) from public, anon, authenticated;

create or replace function public.prosm_time_create_incentive(p_org uuid, p_user uuid, p_rule uuid, p_ref text, p_month date, p_reason text,
                                                               p_type text, p_value numeric, p_by uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_levels text[] := coalesce((select incentive_levels from penalty_settings where organization_id = p_org), array['hr']);
    v_id uuid;
    v_name text := (select full_name from users where id = p_user);
begin
    if p_ref is not null and exists (select 1 from employee_incentives where organization_id = p_org and source_ref = p_ref) then return null; end if;
    insert into employee_incentives (organization_id, user_id, rule_id, source_ref, period_month, reason, amount_type, value, levels, created_by)
    values (p_org, p_user, p_rule, p_ref, p_month, p_reason, p_type, p_value, v_levels, p_by)
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (p_org, p_by, p_user, 'hr.incentive_proposed', 'employee_incentives', v_id, 'Incentive proposed',
            jsonb_build_object('type', p_type, 'value', p_value, 'reason', p_reason));
    perform public.prosm_time_penalty_notify_level(p_org, p_user, v_levels[1], 'incentive_review', 'An incentive to review', coalesce(v_name, ''),
        'employee_incentives', v_id, jsonb_build_object('kind', 'incentive', 'incentiveId', v_id, 'employeeName', v_name, 'reason', p_reason,
                                                        'amountType', p_type, 'value', p_value));
    return v_id;
end;
$$;
revoke all on function public.prosm_time_create_incentive(uuid, uuid, uuid, text, date, text, text, numeric, uuid) from public, anon, authenticated;

create or replace function public.grant_prosm_time_incentive(p_user_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_type text := coalesce(p_data ->> 'amountType', 'amount');
    v_value numeric := nullif(p_data ->> 'value', '')::numeric;
    v_reason text := nullif(trim(coalesce(p_data ->> 'reason', '')), '');
begin
    perform public.prosm_time_require_feature('penalties');
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then raise exception 'NOT FOUND'; end if;
    if p_user_id = v_me or not (public.prosm_time_caller_has_authority_over(p_user_id) or public.prosm_time_is_hr()) then raise exception 'PERMISSION DENIED'; end if;
    if v_type not in ('amount', 'days', 'percent') then raise exception 'INVALID INCENTIVE'; end if;
    if v_value is null or v_value <= 0 or (v_type = 'percent' and v_value > 100) then raise exception 'ENTER THE INCENTIVE VALUE'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    perform public.prosm_time_penalties_seed(v_org);
    return jsonb_build_object('id', public.prosm_time_create_incentive(v_org, p_user_id, null,
        case when nullif(p_data ->> 'clientRef', '') is not null then 'manual:' || (p_data ->> 'clientRef') end,
        null, v_reason, v_type, v_value, v_me));
end;
$$;
revoke all on function public.grant_prosm_time_incentive(uuid, jsonb) from public, anon;
grant execute on function public.grant_prosm_time_incentive(uuid, jsonb) to authenticated;

create or replace function public.act_prosm_time_incentive(p_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_i employee_incentives%rowtype;
    v_note text := nullif(trim(coalesce(p_note, '')), '');
    v_name text;
begin
    perform public.prosm_time_require_feature('penalties');
    select * into v_i from employee_incentives where id = p_id and organization_id = v_org for update;
    if v_i.id is null then raise exception 'NOT FOUND'; end if;
    if p_action = 'cancel' then
        if not public.prosm_time_is_hr() or v_i.status = 'cancelled' then raise exception 'THIS STEP IS NOT AVAILABLE NOW'; end if;
        if v_note is null then raise exception 'A REASON IS REQUIRED'; end if;
        update employee_incentives set status = 'cancelled', decision_note = v_note, updated_at = now() where id = p_id;
    elsif v_i.status <> 'pending_approval' or not public.prosm_time_penalty_can_act_level(v_i.user_id, v_i.levels[v_i.current_level + 1])
          or (v_i.created_by = v_me or v_me = any(v_i.approvers)) and not public.current_prosm_time_user_is_real_owner() then
        raise exception 'THIS STEP IS NOT AVAILABLE NOW';
    elsif p_action = 'reject' then
        if v_note is null then raise exception 'A REASON IS REQUIRED TO REJECT'; end if;
        update employee_incentives set status = 'rejected', decided_by = v_me, decided_at = now(), decision_note = v_note, updated_at = now() where id = p_id;
    elsif p_action = 'approve' then
        if v_i.current_level + 1 < cardinality(v_i.levels) then
            update employee_incentives set current_level = current_level + 1, approvers = approvers || v_me, updated_at = now() where id = p_id returning * into v_i;
            v_name := (select full_name from users where id = v_i.user_id);
            perform public.prosm_time_penalty_notify_level(v_org, v_i.user_id, v_i.levels[v_i.current_level + 1], 'incentive_review', 'An incentive to review',
                coalesce(v_name, ''), 'employee_incentives', p_id, jsonb_build_object('kind', 'incentive', 'incentiveId', p_id, 'employeeName', v_name,
                'reason', v_i.reason, 'amountType', v_i.amount_type, 'value', v_i.value));
        else
            update employee_incentives set status = 'approved', decided_by = v_me, decided_at = now(), decision_note = v_note,
                   amount = public.prosm_time_incentive_amount(user_id, amount_type, value, coalesce(period_month, current_date)), updated_at = now()
            where id = p_id returning * into v_i;
            perform public.create_prosm_time_notification(v_org, v_i.user_id, 'incentive_granted', 'normal', 'Well done!', v_i.reason,
                'employee_incentives', p_id, jsonb_build_object('kind', 'incentive', 'incentiveId', p_id, 'reason', v_i.reason,
                'amountType', v_i.amount_type, 'value', v_i.value, 'amount', v_i.amount, 'templateKey', (select template_key from incentive_rules where id = v_i.rule_id)));
        end if;
    else
        raise exception 'THIS STEP IS NOT AVAILABLE NOW';
    end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_org, v_me, v_i.user_id, 'hr.incentive_' || p_action, 'employee_incentives', p_id, 'Incentive: ' || p_action, v_note);
    perform public.prosm_time_penalties_refresh_payroll(v_i.user_id);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.act_prosm_time_incentive(uuid, text, text) from public, anon;
grant execute on function public.act_prosm_time_incentive(uuid, text, text) to authenticated;

create or replace function public.list_prosm_time_incentives(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
begin
    perform public.prosm_time_require_feature('penalties');
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', i.id, 'userId', i.user_id, 'name', u.full_name, 'reason', i.reason,
                    'templateKey', (select template_key from incentive_rules where id = i.rule_id), 'ruleName', (select name from incentive_rules where id = i.rule_id),
                    'periodMonth', i.period_month, 'amountType', i.amount_type,
                    'value', case when i.amount_type <> 'amount' or i.user_id = v_me or public.prosm_time_is_hr() then i.value end,
                    'amount', case when i.user_id = v_me or public.prosm_time_is_hr() then i.amount end, 'status', i.status,
                    'levels', to_jsonb(i.levels), 'currentLevel', i.current_level, 'createdAt', i.created_at,
                    'createdBy', (select full_name from users where id = i.created_by), 'decidedAt', i.decided_at, 'decisionNote', i.decision_note,
                    'canAct', i.status = 'pending_approval' and public.prosm_time_penalty_can_act_level(i.user_id, i.levels[i.current_level + 1])
                              and ((i.created_by is distinct from v_me and not v_me = any(i.approvers)) or public.current_prosm_time_user_is_real_owner()),
                    'canCancel', i.status <> 'cancelled' and i.user_id <> v_me and public.prosm_time_is_hr())
                    order by i.created_at desc)
        from (select * from employee_incentives i
              where i.organization_id = v_org and (p_user_id is null or i.user_id = p_user_id)
                and case when i.user_id = v_me then i.status = 'approved'
                         else public.prosm_time_is_hr() or public.prosm_time_caller_has_authority_over(i.user_id) end
              order by i.created_at desc limit 500) i
        join users u on u.id = i.user_id), '[]'::jsonb);
end;
$$;
revoke all on function public.list_prosm_time_incentives(uuid) from public, anon;
grant execute on function public.list_prosm_time_incentives(uuid) to authenticated;

-- ---------------------------------------------------------------- payroll: approved deductions and incentives in the open cycle
do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_payroll_build_employee(uuid)'::regprocedure);
    v_delete text := 'delete from payroll_cycle_lines where cycle_employee_id = v_ce.id and source in (''fixed'', ''installment'');';
    v_anchor text := '    perform public.prosm_time_payroll_recalc_employee(v_ce.id);
end;';
begin
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    if position(v_delete in v_def) = 0 then raise exception 'build_employee delete anchor not found'; end if;
    if position(v_anchor in v_def) = 0 then raise exception 'build_employee end anchor not found'; end if;
    v_def := replace(v_def, v_delete, 'delete from payroll_cycle_lines where cycle_employee_id = v_ce.id and source in (''fixed'', ''installment'', ''penalty'', ''incentive'');
    -- 2026-11-11 HR suite: what this cycle took from penalties and incentives is worked out again below
    delete from penalty_payroll_postings where cycle_id = v_ce.cycle_id
        and violation_id in (select id from employee_violations where user_id = v_ce.user_id);
    update employee_incentives set payroll_cycle_id = null where payroll_cycle_id = v_ce.cycle_id and user_id = v_ce.user_id;
    update employee_violations set settlement_cycle_id = null where settlement_cycle_id = v_ce.cycle_id and user_id = v_ce.user_id;');
    v_def := replace(v_def, v_anchor, '    -- 2026-11-11 HR suite: approved penalty deductions (never above the company''s cap in one cycle; the rest is
    -- carried to the next), settlements of cancelled ones already paid, and approved incentives
    if public.prosm_time_plan_allows(v_ce.organization_id, ''penalties'') then
        declare
            v_ps penalty_settings%rowtype;
            v_wage numeric := public.prosm_time_day_wage(v_ce.user_id, v_cycle.period_end);
            v_cap numeric;
            v_left numeric;
            v_take numeric;
            v_pen record;
            v_inc record;
        begin
            select * into v_ps from penalty_settings where organization_id = v_ce.organization_id;
            v_cap := case v_ps.cap_unit
                when ''days_per_month'' then v_ps.cap_days * v_wage
                when ''percent_of_wage'' then v_ps.cap_percent / 100 * v_wage * coalesce((v_cycle.policy_snapshot ->> ''day_divisor'')::numeric, 30)
                when ''both'' then least(v_ps.cap_days * v_wage, v_ps.cap_percent / 100 * v_wage * coalesce((v_cycle.policy_snapshot ->> ''day_divisor'')::numeric, 30))
            end;
            -- the cap is per calendar month: what other cycles of the same month already took counts (review 2026-11-11)
            v_left := greatest(coalesce(v_cap, 0) - coalesce((
                select sum(pp.amount) from penalty_payroll_postings pp join payroll_cycles c on c.id = pp.cycle_id
                join employee_violations x on x.id = pp.violation_id
                where x.user_id = v_ce.user_id and pp.cycle_id <> v_ce.cycle_id and c.status <> ''cancelled''
                  and date_trunc(''month'', c.period_end) = date_trunc(''month'', v_cycle.period_end)), 0), 0);
            for v_pen in
                select e.id, e.amount, e.occurred_on, e.rule_snapshot, e.final_action,
                       e.amount - coalesce((select sum(pp.amount) from penalty_payroll_postings pp join payroll_cycles c on c.id = pp.cycle_id
                                            where pp.violation_id = e.id and pp.cycle_id <> v_ce.cycle_id and c.status <> ''cancelled''), 0) as remaining
                from employee_violations e
                where e.user_id = v_ce.user_id and e.status in (''approved'', ''reduced'') and coalesce(e.amount, 0) > 0
                  and e.occurred_on <= v_cycle.period_end
                order by e.decided_at, e.created_at
            loop
                continue when v_pen.remaining <= 0;
                v_take := least(v_pen.remaining, v_left);
                exit when v_take <= 0;
                v_left := v_left - v_take;
                insert into penalty_payroll_postings (organization_id, violation_id, cycle_id, amount) values (v_ce.organization_id, v_pen.id, v_ce.cycle_id, v_take);
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, raw_amount, include_in_net,
                                                 show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref, notes)
                values (v_ce.organization_id, v_ce.id,
                        ''جزاء: '' || coalesce(v_pen.rule_snapshot #>> ''{type,name}'', ''مخالفة'') || '' ('' || to_char(v_pen.occurred_on, ''YYYY-MM-DD'') || '')'',
                        ''Penalty: '' || coalesce(v_pen.rule_snapshot #>> ''{type,name}'', ''violation'') || '' ('' || to_char(v_pen.occurred_on, ''YYYY-MM-DD'') || '')'',
                        ''deduction'', ''penalty'', v_take, true, true, true, false, 950, false, false,
                        jsonb_build_object(''kind'', ''violation'', ''violationId'', v_pen.id),
                        case when v_take < v_pen.remaining then ''Carried to the next cycle: '' || (v_pen.remaining - v_take) end);
            end loop;
            -- a cancelled penalty: what approved or locked cycles took, less what they already paid back
            for v_pen in
                select e.id, e.rule_snapshot, e.occurred_on,
                       coalesce((select sum(pp.amount) from penalty_payroll_postings pp join payroll_cycles c on c.id = pp.cycle_id
                                 where pp.violation_id = e.id and c.status in (''approved'', ''locked'')), 0)
                     - coalesce((select sum(l.amount) from payroll_cycle_lines l join payroll_cycle_employees x on x.id = l.cycle_employee_id
                                 join payroll_cycles c on c.id = x.cycle_id
                                 where l.source = ''incentive'' and l.source_ref ->> ''settlementOf'' = e.id::text
                                   and c.status in (''approved'', ''locked'') and c.id <> v_ce.cycle_id), 0) as due
                from employee_violations e
                where e.user_id = v_ce.user_id and e.status = ''cancelled''
            loop
                continue when v_pen.due <= 0;
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, raw_amount, include_in_net,
                                                 show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, v_ce.id, ''رد جزاء ملغي ('' || to_char(v_pen.occurred_on, ''YYYY-MM-DD'') || '')'',
                        ''Cancelled penalty refunded ('' || to_char(v_pen.occurred_on, ''YYYY-MM-DD'') || '')'',
                        ''earning'', ''incentive'', v_pen.due, true, true, true, false, 960, false, false,
                        jsonb_build_object(''kind'', ''settlement'', ''settlementOf'', v_pen.id));
            end loop;
            for v_inc in
                select i.* from employee_incentives i
                where i.user_id = v_ce.user_id and i.status = ''approved'' and coalesce(i.amount, 0) > 0
                  and (i.payroll_cycle_id is null or i.payroll_cycle_id in (select id from payroll_cycles where status = ''cancelled''))
                  and coalesce(i.period_month, i.decided_at::date) <= v_cycle.period_end
            loop
                update employee_incentives set payroll_cycle_id = v_ce.cycle_id where id = v_inc.id;
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, raw_amount, include_in_net,
                                                 show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, v_ce.id, ''حافز: '' || left(v_inc.reason, 80), ''Incentive: '' || left(v_inc.reason, 80),
                        ''earning'', ''incentive'', v_inc.amount, true, true, true, false, 940, true, false,
                        jsonb_build_object(''kind'', ''incentive'', ''incentiveId'', v_inc.id));
            end loop;
            -- an incentive cancelled after an approved or locked cycle paid it is taken back once
            for v_inc in
                select i.id, i.reason,
                       coalesce((select sum(l.amount) from payroll_cycle_lines l join payroll_cycle_employees x on x.id = l.cycle_employee_id
                                 join payroll_cycles c on c.id = x.cycle_id
                                 where l.source = ''incentive'' and l.source_ref ->> ''incentiveId'' = i.id::text and c.status in (''approved'', ''locked'')), 0)
                     - coalesce((select sum(l.amount) from payroll_cycle_lines l join payroll_cycle_employees x on x.id = l.cycle_employee_id
                                 join payroll_cycles c on c.id = x.cycle_id
                                 where l.source = ''penalty'' and l.source_ref ->> ''clawbackOf'' = i.id::text
                                   and c.status in (''approved'', ''locked'') and c.id <> v_ce.cycle_id), 0) as due
                from employee_incentives i
                where i.user_id = v_ce.user_id and i.status = ''cancelled''
            loop
                continue when v_inc.due <= 0;
                insert into payroll_cycle_lines (organization_id, cycle_employee_id, name_ar, name_en, category, source, raw_amount, include_in_net,
                                                 show_in_payslip, show_in_summary, include_in_combined, sort_order, taxable, insurable, source_ref)
                values (v_ce.organization_id, v_ce.id, ''استرداد حافز ملغي: '' || left(v_inc.reason, 60), ''Cancelled incentive recovered: '' || left(v_inc.reason, 60),
                        ''deduction'', ''penalty'', v_inc.due, true, true, true, false, 955, false, false,
                        jsonb_build_object(''kind'', ''clawback'', ''clawbackOf'', v_inc.id));
            end loop;
        end;
    end if;

' || v_anchor);
    execute v_def;
end;
$patch$;

-- penalty and incentive lines come from their decisions, never edited or deleted by hand in a cycle
do $patch$
declare
    v_fn text;
    v_def text;
begin
    foreach v_fn in array array['public.save_prosm_time_payroll_line', 'public.delete_prosm_time_payroll_line'] loop
        select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.oid = (select min(oid) from pg_proc where oid::regprocedure::text like replace(v_fn, 'public.', '') || '(%');
        if v_def is null or position('if v_line.source in (''fixed'', ''installment'', ''statutory'') then' in v_def) = 0 then raise exception 'line guard anchor not found in %', v_fn; end if;
        v_def := replace(v_def, 'if v_line.source in (''fixed'', ''installment'', ''statutory'') then', 'if v_line.source in (''fixed'', ''installment'', ''statutory'', ''penalty'', ''incentive'') then');
        execute v_def;
    end loop;
end;
$patch$;

-- ---------------------------------------------------------------- the nightly pass
create or replace function public.process_prosm_time_penalties()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org record;
    v_user record;
    v_today date;
    v_day date;
    v_made integer := 0;
    v_v employee_violations%rowtype;
    v_rule record;
    v_month date;
    v_ok boolean;
begin
    for v_org in
        select o.id, public.prosm_time_site_timezone(null, o.id) as tz from organizations o
        where not public.prosm_time_org_locked(o.id) and public.prosm_time_plan_allows(o.id, 'penalties')
          and exists (select 1 from bylaw_versions b where b.organization_id = o.id)
    loop
        continue when extract(hour from (now() at time zone v_org.tz)) <> 1;
        v_today := (now() at time zone v_org.tz)::date;

        -- the last week's attendance, again (late corrections, leave and permissions approved since)
        for v_user in select u.id from users u where u.organization_id = v_org.id and u.is_active and not u.is_owner loop
            v_day := v_today - 7;
            while v_day < v_today loop
                begin
                    v_made := v_made + public.prosm_time_penalties_evaluate_day(v_user.id, v_day);
                exception when others then null;
                end;
                v_day := v_day + 1;
            end loop;
        end loop;

        -- the reply time is over: on to approval
        for v_v in select * from employee_violations where organization_id = v_org.id and status = 'pending_response' and response_due_at < now() loop
            update employee_violations set status = 'pending_approval', updated_at = now() where id = v_v.id;
            insert into employee_violation_steps (organization_id, violation_id, step_type, note) values (v_org.id, v_v.id, 'response_time_over', null);
            perform public.prosm_time_penalty_notify_level(v_org.id, v_v.user_id, v_v.levels[1], 'penalty_review', 'A penalty to review',
                coalesce((select full_name from users where id = v_v.user_id), ''), 'employee_violations', v_v.id,
                public.prosm_time_violation_note_data(v_v) || jsonb_build_object('step', 'no_reply'));
        end loop;

        -- the company's time limit to impose a penalty is over: closed with no penalty
        update employee_violations e set status = 'lapsed', updated_at = now()
        from penalty_settings s
        where s.organization_id = v_org.id and e.organization_id = v_org.id and s.max_days_to_impose is not null
          and e.status in ('pending_investigation', 'pending_response', 'pending_approval')
          and e.occurred_on + s.max_days_to_impose < v_today;

        -- on the 1st: the monthly incentive rules for last month
        if extract(day from v_today) = 1 then
            v_month := (v_today - 1) - (extract(day from v_today - 1)::integer - 1);
            for v_rule in select * from incentive_rules where organization_id = v_org.id and is_active loop
                for v_user in
                    select u.id from users u where u.organization_id = v_org.id and u.is_active and not u.is_owner
                      and coalesce(u.employment_status, 'active') = 'active' and u.created_at::date <= v_month
                loop
                    v_ok := exists (select 1 from attendance_sessions s where s.user_id = v_user.id
                                    and s.clock_in_at >= (v_month::timestamp at time zone v_org.tz) and s.clock_in_at < ((v_today)::timestamp at time zone v_org.tz));
                    v_day := v_month;
                    while v_ok and v_day < v_today loop
                        if v_rule.source = 'no_late_month' then
                            v_ok := coalesce((public.prosm_time_day_summary(v_user.id, v_day) ->> 'lateMinutes')::numeric, 0) = 0;
                        else
                            v_ok := not public.prosm_time_absent_today(v_user.id, v_day, v_org.tz);
                        end if;
                        v_day := v_day + 1;
                    end loop;
                    if v_ok then
                        perform public.prosm_time_create_incentive(v_org.id, v_user.id, v_rule.id, 'rule:' || v_rule.id || ':' || v_user.id || ':' || v_month,
                            v_month, coalesce(v_rule.name, v_rule.template_key), v_rule.amount_type, v_rule.value, null);
                    end if;
                end loop;
            end loop;
        end if;
    end loop;
    return jsonb_build_object('violations', v_made);
end;
$$;
revoke all on function public.process_prosm_time_penalties() from public, anon, authenticated;
select cron.schedule('prosm-time-penalties', '20 * * * *', $$select public.process_prosm_time_penalties();$$);

commit;
