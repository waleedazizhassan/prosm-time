-- 2026-11-11 (owner): "I want something very strong - the right location, instant notifications." The
-- Android app now follows the shift with its own background service, which keeps working after the app
-- is closed. That service does not share the app's sign-in (two users of one sign-in would end it), so at
-- clock-in the app asks for a tracking key: a random secret for this person and phone, kept here only as
-- a hash, valid 30 days. The service sends each location with it; the server records the location as
-- the app would (exits, exceptions and notifications follow at once) and answers whether the shift is
-- still on - when it is not, the service stops itself. Only an active presence session takes a location.
-- Rollback: drop the two functions and the table.

begin;

create table if not exists public.tracking_keys (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    key_hash text not null unique,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    expires_at timestamptz not null default now() + interval '30 days'
);
create index if not exists tracking_keys_user_idx on public.tracking_keys (user_id);
alter table public.tracking_keys enable row level security;
revoke all on public.tracking_keys from public, anon, authenticated;

-- a new key for the signed-in person (expired ones are removed)
create or replace function public.issue_prosm_time_tracking_key()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_key text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    -- only expired keys go: a phone that was offline for days keeps working with the key it holds
    delete from tracking_keys where user_id = v_me and expires_at < now();
    -- 64 hex characters from two random UUIDs (built in; no extension needed)
    v_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into tracking_keys (organization_id, user_id, key_hash)
    values ((select organization_id from users where id = v_me), v_me, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'));
    return v_key;
end;
$$;
revoke all on function public.issue_prosm_time_tracking_key() from public, anon;
grant execute on function public.issue_prosm_time_tracking_key() to authenticated;

-- a location from the phone's service
create or replace function public.record_prosm_time_location_by_key(
    p_key text,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy double precision default null,
    p_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key tracking_keys%rowtype;
    v_auth uuid;
    v_presence uuid;
    v_result jsonb;
begin
    if p_key is null or length(p_key) < 32 then return jsonb_build_object('active', false, 'reason', 'key'); end if;
    select * into v_key from tracking_keys where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') and expires_at > now();
    if v_key.id is null then return jsonb_build_object('active', false, 'reason', 'key'); end if;
    select auth_user_id into v_auth from users where id = v_key.user_id and is_active;
    if v_auth is null then return jsonb_build_object('active', false, 'reason', 'user'); end if;

    select p.id into v_presence
    from presence_sessions p
    join attendance_sessions a on a.id = p.attendance_session_id
    where p.user_id = v_key.user_id and p.status = 'active' and a.status = 'clocked_in'
    order by p.started_at desc limit 1;
    if v_presence is null then return jsonb_build_object('active', false, 'reason', 'no_shift'); end if;

    -- the same path as a location sent by the app: as this person
    perform set_config('request.jwt.claim.sub', v_auth::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    v_result := public.record_prosm_time_presence_sample(v_presence, p_latitude, p_longitude, p_accuracy, p_at);
    update tracking_keys set last_used_at = now() where id = v_key.id;
    return coalesce(v_result, '{}'::jsonb) || jsonb_build_object('active', true);
end;
$$;
revoke all on function public.record_prosm_time_location_by_key(text, double precision, double precision, double precision, timestamptz) from public;
grant execute on function public.record_prosm_time_location_by_key(text, double precision, double precision, double precision, timestamptz) to anon, authenticated;

commit;
