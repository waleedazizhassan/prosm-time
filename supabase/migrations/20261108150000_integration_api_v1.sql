-- 2026-11-08: a general integration API (owner: "an independent, professional API any system can
-- integrate with - not one shaped for PROSM Finance or PROSM Projects").
--   * API keys: several scopes each, an optional expiry, test/live, shown once, stored hashed,
--     created and revoked by the real owner only (never by a delegate).
--   * One authentication path for every endpoint: not revoked, not expired, the organisation not
--     locked, and the scope required by the endpoint. The organisation always comes from the key.
--   * Generic read endpoints with stable ids and cursor pagination: employees, sites, attendance,
--     leaves, and payroll records of LOCKED cycles only (no extra allowances, no external workers).
--     Personal contact data (email) needs its own scope.
--   * A request log without payloads (who, what path, status, duration, correlation id).
--   * The legacy export endpoints keep working, now through the same checks: attendance/sites/
--     workers need attendance:read (payroll keys keep it, so nothing breaks), and a locked or
--     expired organisation is refused everywhere.
-- Tables stay RPC-only; the gateway is the api-v1 Edge Function (service role inside, the key's
-- organisation passed explicitly - D-IC2 option B).

begin;

-- 1. Keys ----------------------------------------------------------------------------------------
alter table public.api_keys
    add column if not exists scopes text[] not null default '{}'::text[],
    add column if not exists expires_at timestamptz,
    add column if not exists environment text not null default 'live';

do $$
declare
    v_name text;
begin
    for v_name in select conname from pg_constraint where conrelid = 'public.api_keys'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%scope%' loop
        execute format('alter table public.api_keys drop constraint %I', v_name);
    end loop;
    if not exists (select 1 from pg_constraint where conname = 'api_keys_environment_check') then
        alter table public.api_keys add constraint api_keys_environment_check check (environment in ('live', 'test'));
    end if;
end $$;

-- existing keys keep exactly what they could do: their scope, and attendance for payroll keys
-- (the legacy attendance endpoints never checked the scope before)
update public.api_keys set scopes = case when scope = 'payroll:read' then array['payroll:read', 'attendance:read', 'sites:read', 'employees:read', 'leaves:read']
                                          else array['attendance:read', 'sites:read', 'employees:read'] end
where cardinality(scopes) = 0;

create or replace function public.prosm_time_api_scopes()
returns text[]
language sql
immutable
set search_path = public
as $$
    select array['employees:read', 'employees:read_sensitive', 'sites:read', 'attendance:read', 'leaves:read', 'payroll:read'];
$$;
revoke all on function public.prosm_time_api_scopes() from public, anon;
grant execute on function public.prosm_time_api_scopes() to authenticated, service_role;

-- The API is a plan feature in the strict sense: the plan must name it (owner 2026-11-03 removed
-- it from every plan, legacy and trials included), unlike the screens that legacy/trial unlock.
create or replace function public.prosm_time_api_enabled(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from entitlements e join plans p on p.key = e.plan
                   where e.organization_id = p_org and coalesce((p.feature_flags ->> 'integrations')::boolean, false));
$$;
revoke all on function public.prosm_time_api_enabled(uuid) from public, anon, authenticated;

create or replace function public.generate_prosm_time_api_key_v2(p_name text, p_scopes text[], p_expires_at timestamptz default null, p_environment text default 'live')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_scopes text[] := array(select distinct s from unnest(coalesce(p_scopes, array[]::text[])) s where s is not null order by 1);
    v_plain text;
    v_id uuid;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY CREATE AN API KEY'; end if;
    if not public.prosm_time_api_enabled(v_org) then raise exception 'FEATURE NOT IN PLAN: integrations'; end if;
    if p_name is null or length(trim(p_name)) = 0 then raise exception 'A NAME IS REQUIRED FOR THIS API KEY'; end if;
    if cardinality(v_scopes) = 0 then raise exception 'CHOOSE AT LEAST ONE SCOPE'; end if;
    if exists (select 1 from unnest(v_scopes) s where not (s = any(public.prosm_time_api_scopes()))) then raise exception 'INVALID API KEY SCOPE'; end if;
    if 'employees:read_sensitive' = any(v_scopes) and not ('employees:read' = any(v_scopes)) then v_scopes := v_scopes || 'employees:read'; end if;
    if p_environment not in ('live', 'test') then raise exception 'INVALID ENVIRONMENT'; end if;
    if p_expires_at is not null and p_expires_at <= now() then raise exception 'THE EXPIRY MUST BE IN THE FUTURE'; end if;

    v_plain := 'ptime_' || p_environment || '_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into api_keys (organization_id, name, key_hash, key_prefix, scope, scopes, expires_at, environment, created_by)
    values (v_org, trim(p_name), encode(sha256(convert_to(v_plain, 'utf8')), 'hex'), substring(v_plain, 1, 18), v_scopes[1], v_scopes, p_expires_at, p_environment, v_caller)
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, context)
    values (v_org, v_caller, 'API_KEY_CREATED', 'api_keys', v_id, 'Created an API key: ' || trim(p_name),
            jsonb_build_object('scopes', to_jsonb(v_scopes), 'environment', p_environment, 'expiresAt', p_expires_at));
    return jsonb_build_object('success', true, 'keyId', v_id, 'apiKey', v_plain);
end;
$$;
revoke all on function public.generate_prosm_time_api_key_v2(text, text[], timestamptz, text) from public, anon;
grant execute on function public.generate_prosm_time_api_key_v2(text, text[], timestamptz, text) to authenticated;

-- the original one-scope function now goes through the same path
create or replace function public.generate_prosm_time_api_key(p_name text, p_scope text default 'attendance:read')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    return public.generate_prosm_time_api_key_v2(p_name,
        case when p_scope = 'payroll:read' then array['payroll:read', 'attendance:read', 'sites:read', 'employees:read', 'leaves:read'] else array['attendance:read', 'sites:read', 'employees:read'] end);
end;
$$;

create or replace function public.list_prosm_time_api_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.current_prosm_time_user_is_real_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MANAGES API KEYS'; end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'keyPrefix', k.key_prefix, 'scopes', to_jsonb(k.scopes), 'environment', k.environment,
                                            'expiresAt', k.expires_at, 'createdAt', k.created_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at,
                                            'requests7d', (select count(*) from api_request_log l where l.api_key_id = k.id and l.created_at > now() - interval '7 days'))
                         order by k.revoked_at nulls first, k.created_at desc)
        from api_keys k where k.organization_id = public.current_prosm_time_organization_id()
    ), '[]'::jsonb);
end;
$$;

-- revoking is protective: the owner or a full delegate may revoke a leaked key at once
create or replace function public.revoke_prosm_time_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY REVOKE AN API KEY'; end if;
    update api_keys set revoked_at = now() where id = p_key_id and organization_id = v_org and revoked_at is null returning id into v_id;
    if v_id is null then raise exception 'API KEY NOT FOUND'; end if;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, public.current_prosm_time_user_id(), 'API_KEY_REVOKED', 'api_keys', v_id, 'Revoked an API key.');
    return jsonb_build_object('success', true);
end;
$$;

-- 2. The request log (no payloads, no amounts, no personal data) --------------------------------
create table if not exists public.api_request_log (
    id bigint generated always as identity primary key,
    organization_id uuid references public.organizations(id) on delete cascade,
    api_key_id uuid references public.api_keys(id) on delete set null,
    method text not null,
    path text not null,
    status integer not null,
    duration_ms integer,
    correlation_id text,
    created_at timestamptz not null default now()
);
create index if not exists api_request_log_key_idx on public.api_request_log (api_key_id, created_at desc);
create index if not exists api_request_log_org_idx on public.api_request_log (organization_id, created_at desc);
alter table public.api_request_log enable row level security;
revoke all on public.api_request_log from anon, authenticated;

create or replace function public.log_prosm_time_api_request(p_org uuid, p_key uuid, p_method text, p_path text, p_status integer, p_duration integer, p_correlation text)
returns void
language sql
security definer
set search_path = public
as $$
    insert into api_request_log (organization_id, api_key_id, method, path, status, duration_ms, correlation_id)
    values (p_org, p_key, left(p_method, 10), left(p_path, 200), p_status, p_duration, left(p_correlation, 80));
$$;
revoke all on function public.log_prosm_time_api_request(uuid, uuid, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.log_prosm_time_api_request(uuid, uuid, text, text, integer, integer, text) to service_role;

-- 3. One authentication path --------------------------------------------------------------------
-- p_require_plan: the v1 endpoints follow the plan (owner 2026-11-03: no plan includes the API
-- yet, so v1 answers nothing until the owner turns it on); the legacy export endpoints keep
-- working for the keys already in use, as before, but now with scope, expiry and lock checks.
create or replace function public.prosm_time_api_key_check(p_raw_key text, p_required_scope text, p_require_plan boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key api_keys%rowtype;
    v_scopes text[];
begin
    if p_raw_key is null or length(p_raw_key) < 8 then return null; end if;
    select * into v_key from api_keys where key_hash = encode(sha256(convert_to(p_raw_key, 'utf8')), 'hex');
    if v_key.id is null or v_key.revoked_at is not null then return null; end if;
    if v_key.expires_at is not null and v_key.expires_at <= now() then return null; end if;
    if public.prosm_time_org_locked(v_key.organization_id) then return null; end if;
    if p_require_plan and not public.prosm_time_api_enabled(v_key.organization_id) then return null; end if;
    v_scopes := case when cardinality(v_key.scopes) > 0 then v_key.scopes
                     when v_key.scope = 'payroll:read' then array['payroll:read', 'attendance:read', 'sites:read', 'employees:read', 'leaves:read']
                     else array['attendance:read', 'sites:read', 'employees:read'] end;
    if p_required_scope is not null and not (p_required_scope = any(v_scopes)) then
        return jsonb_build_object('organizationId', v_key.organization_id, 'keyId', v_key.id, 'scopeDenied', true);
    end if;
    update api_keys set last_used_at = now() where id = v_key.id;
    return jsonb_build_object('organizationId', v_key.organization_id, 'keyId', v_key.id, 'environment', v_key.environment, 'scopes', to_jsonb(v_scopes));
end;
$$;
revoke all on function public.prosm_time_api_key_check(text, text, boolean) from public, anon, authenticated;
grant execute on function public.prosm_time_api_key_check(text, text, boolean) to service_role;

create or replace function public.authenticate_prosm_time_api_key_v1(p_raw_key text, p_required_scope text)
returns jsonb
language sql
security definer
set search_path = public
as $$
    select public.prosm_time_api_key_check(p_raw_key, p_required_scope, true);
$$;
revoke all on function public.authenticate_prosm_time_api_key_v1(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_prosm_time_api_key_v1(text, text) to service_role;

-- the legacy endpoints, through the same checks (attendance/sites/workers: attendance:read)
create or replace function public.authenticate_prosm_time_api_key(p_raw_key text)
returns uuid
language sql
security definer
set search_path = public
as $$
    select case when r is not null and not coalesce((r ->> 'scopeDenied')::boolean, false) then (r ->> 'organizationId')::uuid end
    from (select public.prosm_time_api_key_check(p_raw_key, 'attendance:read', false) as r) x;
$$;
create or replace function public.authenticate_prosm_time_api_key_with_scope(p_raw_key text, p_required_scope text)
returns uuid
language sql
security definer
set search_path = public
as $$
    select case when r is not null and not coalesce((r ->> 'scopeDenied')::boolean, false) then (r ->> 'organizationId')::uuid end
    from (select public.prosm_time_api_key_check(p_raw_key, p_required_scope, false) as r) x;
$$;
revoke all on function public.authenticate_prosm_time_api_key(text) from public, anon, authenticated;
revoke all on function public.authenticate_prosm_time_api_key_with_scope(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_prosm_time_api_key(text) to service_role;
grant execute on function public.authenticate_prosm_time_api_key_with_scope(text, text) to service_role;

-- 4. The v1 resources (service role only; the organisation comes from the key) -------------------
create or replace function public.api_v1_employees(p_org uuid, p_after uuid, p_limit integer, p_sensitive boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'id')), '[]'::jsonb) from (
        select jsonb_build_object(
            'id', u.id, 'name', u.full_name, 'role', r.role_key, 'active', u.is_active,
            'siteIds', coalesce((select jsonb_agg(sa.site_id order by sa.site_id) from site_assignments sa where sa.user_id = u.id), '[]'::jsonb),
            'employeeCode', (select p.employee_code from payroll_profiles p where p.user_id = u.id),
            'updatedAt', u.updated_at)
            || case when p_sensitive then jsonb_build_object('email', u.email) else '{}'::jsonb end as row
        from users u left join roles r on r.id = u.role_id
        where u.organization_id = p_org and (p_after is null or u.id > p_after)
        order by u.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

create or replace function public.api_v1_sites(p_org uuid, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'id')), '[]'::jsonb) from (
        select jsonb_build_object('id', s.id, 'name', s.name, 'active', coalesce(s.attendance_allowed, true), 'timezone', s.timezone,
                                  'latitude', s.latitude, 'longitude', s.longitude, 'radiusMeters', s.allowed_radius_meters, 'createdAt', s.created_at) as row
        from sites s where s.organization_id = p_org and (p_after is null or s.id > p_after)
        order by s.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

create or replace function public.api_v1_attendance(p_org uuid, p_since timestamptz, p_until timestamptz, p_after_at timestamptz, p_after_id uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'clockInAt'), (row ->> 'id')), '[]'::jsonb) from (
        select jsonb_build_object(
            'id', a.id, 'employeeId', a.user_id, 'siteId', coalesce(a.site_id, a.responsible_site_id), 'projectId', a.project_id,
            'status', a.status, 'clockInAt', a.clock_in_at, 'clockOutAt', a.clock_out_at,
            'workedMinutes', case when a.clock_out_at is not null then round((extract(epoch from (a.clock_out_at - a.clock_in_at)) / 60)::numeric, 1) end,
            'breakMinutes', round(coalesce((select sum(extract(epoch from (coalesce(b.ended_at, now()) - b.started_at)) / 60) from break_events b where b.attendance_session_id = a.id), 0)::numeric, 1),
            'verified', not exists (select 1 from geofence_exceptions ge join attendance_events ae on ae.id = ge.attendance_event_id where ae.session_id = a.id)
        ) as row
        from attendance_sessions a
        where a.organization_id = p_org and a.clock_in_at >= p_since and a.clock_in_at < p_until
          and (p_after_at is null or (a.clock_in_at, a.id) > (p_after_at, p_after_id))
        order by a.clock_in_at, a.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

create or replace function public.api_v1_leaves(p_org uuid, p_since date, p_until date, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'id')), '[]'::jsonb) from (
        select jsonb_build_object('id', l.id, 'employeeId', l.user_id, 'type', l.leave_type, 'startDate', l.start_date, 'endDate', l.end_date,
                                  'workingDays', l.days_count, 'status', l.status, 'updatedAt', l.updated_at) as row
        from leave_requests l
        where l.organization_id = p_org and l.end_date >= p_since and l.start_date <= p_until and (p_after is null or l.id > p_after)
        order by l.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

-- payroll: locked cycles only, from the stored version; totals of the net (never the extra allowances)
create or replace function public.api_v1_payroll_records(p_org uuid, p_cycle_id uuid, p_after text, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'cursor')), '[]'::jsonb) from (
        select jsonb_build_object(
            'cursor', c.id::text || ':' || (e ->> 'user_id'),
            'cycleId', c.id, 'cycleTitle', c.title, 'periodStart', c.period_start, 'periodEnd', c.period_end, 'cycleVersion', c.cycle_version,
            'employeeId', e ->> 'user_id', 'employeeCode', e ->> 'employee_code', 'currency', e ->> 'currency',
            'totalEarnings', (e ->> 'total_earnings')::numeric, 'totalDeductions', (e ->> 'total_deductions')::numeric,
            'totalInstallments', (e ->> 'total_installments')::numeric, 'netSalary', (e ->> 'net_salary')::numeric,
            'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l ->> 'name_ar', 'nameEn', l ->> 'name_en', 'category', l ->> 'category', 'amount', (l ->> 'amount')::numeric)
                                                order by (l ->> 'sort_order')::int)
                               from jsonb_array_elements(e -> 'lines') l where (l ->> 'include_in_net')::boolean), '[]'::jsonb)
        ) as row
        from payroll_cycles c
        join payroll_cycle_snapshots s on s.cycle_id = c.id and s.cycle_version = c.cycle_version
        cross join lateral jsonb_array_elements(s.data -> 'employees') e
        where c.organization_id = p_org and c.status = 'locked' and (p_cycle_id is null or c.id = p_cycle_id)
          and (p_after is null or (c.id::text || ':' || (e ->> 'user_id')) > p_after)
        order by c.id::text || ':' || (e ->> 'user_id')
        limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array['public.api_v1_employees(uuid,uuid,integer,boolean)', 'public.api_v1_sites(uuid,uuid,integer)',
        'public.api_v1_attendance(uuid,timestamptz,timestamptz,timestamptz,uuid,integer)', 'public.api_v1_leaves(uuid,date,date,uuid,integer)',
        'public.api_v1_payroll_records(uuid,uuid,text,integer)'] loop
        execute format('revoke all on function %s from public, anon, authenticated', v_fn);
        execute format('grant execute on function %s to service_role', v_fn);
    end loop;
end $$;

revoke all on function public.list_prosm_time_api_keys() from public, anon;
grant execute on function public.list_prosm_time_api_keys() to authenticated;

commit;
