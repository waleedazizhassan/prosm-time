-- PROSM Time - user-directed: infrastructure for a brand-new sibling
-- product, PROSM Finance, which needs real labor cost (hours × rate)
-- to build job-costing/WIP reporting. Grepping this whole repo for
-- rate/wage/salary found zero hits - no compensation concept exists
-- anywhere, not even inside the QuickBooks sync (which pushes hours
-- only, never a dollar amount or rate). Time already owns the worker
-- identity (users for employees, site_workers for external/kiosk
-- workers) that a rate has to attach to, so rate lives here rather
-- than PROSM Finance duplicating an entire worker roster just to hang
-- a number on it.
--
-- Stored as HISTORY (effective_from/effective_to), not a single
-- mutable field - a retroactive-correct labor-cost calculation needs
-- to know what the rate WAS on a given work date, not just what it is
-- today. Owner-only visibility throughout - this is compensation data,
-- a materially more sensitive category than attendance/clock times.

begin;

create table public.worker_pay_rates (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid references public.users(id) on delete cascade,
    site_worker_id uuid references public.site_workers(id) on delete cascade,
    rate_type text not null default 'HOURLY' check (rate_type in ('HOURLY', 'MONTHLY')),
    rate_amount numeric(12,2) not null check (rate_amount > 0),
    currency text not null default 'EGP',
    effective_from date not null default current_date,
    effective_to date,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    check ((user_id is not null and site_worker_id is null) or (user_id is null and site_worker_id is not null)),
    check (effective_to is null or effective_to >= effective_from)
);

create index worker_pay_rates_org_idx on public.worker_pay_rates(organization_id);
create index worker_pay_rates_user_idx on public.worker_pay_rates(user_id) where user_id is not null;
create index worker_pay_rates_site_worker_idx on public.worker_pay_rates(site_worker_id) where site_worker_id is not null;
-- Only one OPEN-ENDED (current) rate per worker at a time - set_worker_pay_rate
-- below always closes the prior open row before inserting a new one, this is
-- the integrity backstop for that invariant.
create unique index worker_pay_rates_one_open_per_user_idx on public.worker_pay_rates(user_id) where effective_to is null and user_id is not null;
create unique index worker_pay_rates_one_open_per_site_worker_idx on public.worker_pay_rates(site_worker_id) where effective_to is null and site_worker_id is not null;

alter table public.worker_pay_rates enable row level security;

revoke all on public.worker_pay_rates from anon, authenticated;
grant select on public.worker_pay_rates to authenticated;

create policy "owner can view own organization worker pay rates"
on public.worker_pay_rates for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

-- Inserts a new open-ended rate row and closes whichever row was
-- previously open for this worker (effective_to = day before the new
-- rate's effective_from) - this is how a "history" table gets a
-- change instead of an in-place update, which would destroy the
-- record of what the rate used to be.
create or replace function public.set_worker_pay_rate(
    p_user_id uuid,
    p_site_worker_id uuid,
    p_rate_type text,
    p_rate_amount numeric,
    p_currency text default 'EGP',
    p_effective_from date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_rate_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY SET PAY RATES';
    end if;

    v_org := public.current_prosm_time_organization_id();

    if (p_user_id is null) = (p_site_worker_id is null) then
        raise exception 'EXACTLY ONE OF USER OR SITE WORKER MUST BE PROVIDED';
    end if;
    if p_user_id is not null and not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if p_site_worker_id is not null and not exists (select 1 from site_workers where id = p_site_worker_id and organization_id = v_org) then
        raise exception 'SITE WORKER NOT FOUND';
    end if;
    if p_rate_type not in ('HOURLY', 'MONTHLY') then
        raise exception 'INVALID RATE TYPE';
    end if;
    if p_rate_amount is null or p_rate_amount <= 0 then
        raise exception 'RATE AMOUNT MUST BE GREATER THAN ZERO';
    end if;

    update worker_pay_rates
    set effective_to = p_effective_from - 1
    where effective_to is null
      and ((p_user_id is not null and user_id = p_user_id) or (p_site_worker_id is not null and site_worker_id = p_site_worker_id));

    insert into worker_pay_rates (organization_id, user_id, site_worker_id, rate_type, rate_amount, currency, effective_from, created_by)
    values (v_org, p_user_id, p_site_worker_id, p_rate_type, p_rate_amount, coalesce(p_currency, 'EGP'), p_effective_from, v_caller_id)
    returning id into v_rate_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'WORKER_PAY_RATE_SET', 'worker_pay_rates', v_rate_id, 'Set a worker pay rate.');

    return jsonb_build_object('success', true, 'rateId', v_rate_id);
exception
    when others then
        raise exception 'SET WORKER PAY RATE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.set_worker_pay_rate(uuid, uuid, text, numeric, text, date) to authenticated;

-- Widen the existing scope check (previously 'attendance:read' only)
-- rather than restructure the column into an array - a key keeps a
-- SINGLE scope, so PROSM Finance holds two separate keys (one
-- attendance:read, one payroll:read) instead of one combined key -
-- smaller blast radius per key if either ever leaks, and this is a
-- pure constraint-widen, zero risk to the existing attendance:read
-- key already issued to PROSM Projects.
alter table public.api_keys drop constraint if exists api_keys_scope_check;
alter table public.api_keys add constraint api_keys_scope_check check (scope in ('attendance:read', 'payroll:read'));

-- generate_prosm_time_api_key gains an optional p_scope param
-- (default 'attendance:read' preserves every existing call site's
-- behavior exactly) instead of the scope being hardcoded to the
-- table's default.
create or replace function public.generate_prosm_time_api_key(p_name text, p_scope text default 'attendance:read')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_plaintext text;
    v_hash text;
    v_key_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY CREATE AN API KEY';
    end if;
    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'A NAME IS REQUIRED FOR THIS API KEY';
    end if;
    if p_scope not in ('attendance:read', 'payroll:read') then
        raise exception 'INVALID API KEY SCOPE';
    end if;

    v_org := public.current_prosm_time_organization_id();

    v_plaintext := 'ptime_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_hash := encode(sha256(convert_to(v_plaintext, 'utf8')), 'hex');

    insert into api_keys (organization_id, name, key_hash, key_prefix, scope, created_by)
    values (v_org, trim(p_name), v_hash, substring(v_plaintext, 1, 14), p_scope, v_caller_id)
    returning id into v_key_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'API_KEY_CREATED', 'api_keys', v_key_id, 'Created an external API key: ' || trim(p_name) || ' (' || p_scope || ').');

    return jsonb_build_object('success', true, 'keyId', v_key_id, 'apiKey', v_plaintext);
exception
    when others then
        raise exception 'GENERATE PROSM TIME API KEY FAILED: %', sqlerrm;
end;
$function$;

-- New, does not replace authenticate_prosm_time_api_key (still used
-- as-is by export-attendance/export-worker-attendance, unchanged) -
-- this variant ALSO checks the key's own scope matches what the
-- caller endpoint requires, so a payroll:read key structurally cannot
-- be used against export-attendance and vice versa.
create or replace function public.authenticate_prosm_time_api_key_with_scope(p_raw_key text, p_required_scope text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_hash text;
    v_key_id uuid;
    v_org uuid;
    v_scope text;
begin
    if p_raw_key is null or length(p_raw_key) = 0 then
        return null;
    end if;

    v_hash := encode(sha256(convert_to(p_raw_key, 'utf8')), 'hex');

    select id, organization_id, scope into v_key_id, v_org, v_scope
    from api_keys
    where key_hash = v_hash and revoked_at is null;

    if v_key_id is null or v_scope is distinct from p_required_scope then
        return null;
    end if;

    update api_keys set last_used_at = now() where id = v_key_id;

    return v_org;
end;
$function$;

revoke execute on function public.authenticate_prosm_time_api_key_with_scope(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_prosm_time_api_key_with_scope(text, text) to service_role;

-- Internal-only, service_role-only (mirrors list_prosm_time_
-- attendance_export's own posture exactly). Returns every rate row
-- whose effective range overlaps [p_since, p_until] for EITHER worker
-- population (employees via users, external/kiosk via site_workers) -
-- PROSM Finance needs the full overlapping set, not just "the current
-- rate," so it can correctly cost historical hours against the rate
-- that was actually in force on each work date.
create or replace function public.list_prosm_time_worker_rates_export(
    p_organization_id uuid,
    p_since date,
    p_until date
)
returns table (
    worker_type text,
    worker_id uuid,
    worker_name text,
    worker_email text,
    worker_number text,
    rate_type text,
    rate_amount numeric,
    currency text,
    effective_from date,
    effective_to date
)
language plpgsql
security definer
set search_path = public
as $function$
begin
    return query
    select
        case when wpr.user_id is not null then 'EMPLOYEE' else 'SITE_WORKER' end as worker_type,
        coalesce(wpr.user_id, wpr.site_worker_id) as worker_id,
        coalesce(u.full_name, sw.full_name) as worker_name,
        u.email as worker_email,
        sw.worker_number as worker_number,
        wpr.rate_type,
        wpr.rate_amount,
        wpr.currency,
        wpr.effective_from,
        wpr.effective_to
    from worker_pay_rates wpr
    left join users u on u.id = wpr.user_id
    left join site_workers sw on sw.id = wpr.site_worker_id
    where wpr.organization_id = p_organization_id
      and wpr.effective_from <= p_until
      and (wpr.effective_to is null or wpr.effective_to >= p_since)
    order by coalesce(u.full_name, sw.full_name);
end;
$function$;

revoke execute on function public.list_prosm_time_worker_rates_export(uuid, date, date) from public, anon, authenticated;
grant execute on function public.list_prosm_time_worker_rates_export(uuid, date, date) to service_role;

commit;
