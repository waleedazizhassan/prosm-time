-- PROSM Time - user-directed: a real, scoped integration surface so
-- sibling PROSM products (starting with PROSM Projects, whose own
-- attendance_entries is entirely hand-typed today - no GPS, no photo,
-- no verification of any kind) can pull PROSM Time's real, geofence/
-- camera-verified attendance records instead of manual entry.
--
-- Mirrors the existing PROSM Management product-registry API key
-- pattern exactly (20260831100000_prosm_management_product_registry.sql
-- - "Only the SHA-256 hash is ever stored; the plaintext key is
-- returned exactly once") - same shape, own independent table, no
-- cross-repo/cross-database dependency. Read-only, single scope
-- ('attendance:read') - this key can never write anything back into
-- PROSM Time, and never exposes anything beyond one organization's own
-- completed (clocked-out) attendance sessions.

begin;

create table public.api_keys (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null,
    key_hash text not null unique,
    key_prefix text not null,
    scope text not null default 'attendance:read' check (scope in ('attendance:read')),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);

create index api_keys_organization_id_idx on public.api_keys(organization_id);
create index api_keys_key_hash_idx on public.api_keys(key_hash);

alter table public.api_keys enable row level security;

revoke all on public.api_keys from anon, authenticated;
grant select on public.api_keys to authenticated;

-- Owner-only visibility - this is credential metadata (never the
-- plaintext key, which is never stored at all), same posture as the
-- platform's own api_key_hash columns.
create policy "owner can view own organization api keys"
on public.api_keys for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

create or replace function public.generate_prosm_time_api_key(p_name text)
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

    v_org := public.current_prosm_time_organization_id();

    v_plaintext := 'ptime_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_hash := encode(sha256(convert_to(v_plaintext, 'utf8')), 'hex');

    insert into api_keys (organization_id, name, key_hash, key_prefix, created_by)
    values (v_org, trim(p_name), v_hash, substring(v_plaintext, 1, 14), v_caller_id)
    returning id into v_key_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'API_KEY_CREATED', 'api_keys', v_key_id, 'Created an external attendance API key: ' || trim(p_name) || '.');

    -- The one and only time the plaintext value is ever returned - the
    -- caller must copy it now; only the hash is retrievable afterward.
    return jsonb_build_object('success', true, 'keyId', v_key_id, 'apiKey', v_plaintext);
exception
    when others then
        raise exception 'GENERATE PROSM TIME API KEY FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.revoke_prosm_time_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY REVOKE AN API KEY';
    end if;

    v_org := public.current_prosm_time_organization_id();

    if not exists (select 1 from api_keys where id = p_key_id and organization_id = v_org) then
        raise exception 'API KEY NOT FOUND';
    end if;

    update api_keys set revoked_at = now() where id = p_key_id and revoked_at is null;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller_id, 'API_KEY_REVOKED', 'api_keys', p_key_id, 'Revoked an external attendance API key.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REVOKE PROSM TIME API KEY FAILED: %', sqlerrm;
end;
$function$;

-- Internal-only: called from the export-attendance Edge Function with
-- the service role, never by a client directly. Validates the raw key
-- (re-hashed here, never trusting a client-supplied hash) and returns
-- the owning organization_id, or null if invalid/revoked - the Edge
-- Function itself decides how to respond to that.
create or replace function public.authenticate_prosm_time_api_key(p_raw_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_hash text;
    v_key_id uuid;
    v_org uuid;
begin
    if p_raw_key is null or length(p_raw_key) = 0 then
        return null;
    end if;

    v_hash := encode(sha256(convert_to(p_raw_key, 'utf8')), 'hex');

    select id, organization_id into v_key_id, v_org
    from api_keys
    where key_hash = v_hash and revoked_at is null;

    if v_key_id is null then
        return null;
    end if;

    update api_keys set last_used_at = now() where id = v_key_id;

    return v_org;
end;
$function$;

revoke execute on function public.generate_prosm_time_api_key(text) from public, anon;
revoke execute on function public.revoke_prosm_time_api_key(uuid) from public, anon;
revoke execute on function public.authenticate_prosm_time_api_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_prosm_time_api_key(text) to service_role;

-- Internal-only, service_role-only (called from export-attendance
-- after authenticate_prosm_time_api_key already resolved the caller's
-- organization - there is no ordinary authenticated user in this
-- request at all, so this cannot reuse get_prosm_time_session_summary,
-- which is gated to the CALLER's own current_prosm_time_user_id()).
-- Mirrors that function's own overtime formula (site clock-time rule
-- when configured, else worked-minus-break-minus-daily-threshold),
-- computed set-based for every completed session in the window instead
-- of one at a time. "verified" is true only when the session raised no
-- geofence_exceptions row at all - a real out-of-zone clock-in/out
-- still exports (never silently hidden), just flagged honestly.
create or replace function public.list_prosm_time_attendance_export(
    p_organization_id uuid,
    p_since timestamptz,
    p_until timestamptz
)
returns table (
    session_id uuid,
    employee_name text,
    employee_email text,
    site_name text,
    clock_in_at timestamptz,
    clock_out_at timestamptz,
    worked_minutes numeric,
    break_minutes numeric,
    overtime_minutes numeric,
    verified boolean,
    has_photo_evidence boolean
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org_threshold integer;
begin
    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = p_organization_id;

    return query
    select
        ats.id,
        u.full_name,
        u.email,
        s.name,
        ats.clock_in_at,
        ats.clock_out_at,
        round((extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60)::numeric, 1) as worked_minutes,
        round(coalesce((
            select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60)
            from break_events be where be.attendance_session_id = ats.id
        ), 0)::numeric, 1) as break_minutes,
        round((case
            when s.overtime_start_time is not null then
                greatest(extract(epoch from ((ats.clock_out_at at time zone coalesce(s.timezone, 'UTC'))::time - s.overtime_start_time)) / 60, 0)
            else
                greatest(
                    (extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60)
                    - coalesce((select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60) from break_events be where be.attendance_session_id = ats.id), 0)
                    - coalesce(s.daily_overtime_threshold_minutes, v_org_threshold, 480),
                    0
                )
        end)::numeric, 1) as overtime_minutes,
        not exists (
            select 1 from geofence_exceptions ge
            join attendance_events ae on ae.id = ge.attendance_event_id
            where ae.session_id = ats.id
        ) as verified,
        exists (select 1 from camera_evidence ce where ce.user_id = ats.user_id and ce.attendance_event_id in (
            select ae2.id from attendance_events ae2 where ae2.session_id = ats.id
        )) as has_photo_evidence
    from attendance_sessions ats
    join users u on u.id = ats.user_id
    left join sites s on s.id = ats.site_id
    where ats.organization_id = p_organization_id
      and ats.status = 'clocked_out'
      and ats.clock_out_at between p_since and p_until
    order by ats.clock_out_at desc
    limit 500;
end;
$function$;

revoke execute on function public.list_prosm_time_attendance_export(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.list_prosm_time_attendance_export(uuid, timestamptz, timestamptz) to service_role;

commit;
