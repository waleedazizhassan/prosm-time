-- PROSM Connect - TURN bandwidth strategy (owner 2026-11-16: the free Metered plan has 500 MB a month; P2P first,
-- relay only when needed, measure what is used, warn at 50/75/90 %, and at 95 % stop handing out that relay - never
-- cutting a call that is already talking).
--   * connect_turn_usage: what each call or meeting actually carried and how - direct (host / srflx / prflx) or
--     through a relay (and which one). Reported by the app from the connection's own counters (getStats): a device
--     reports only what went through ITS OWN relay allocation, so the sum is what the relay server carried.
--   * record_prosm_time_connect_usage: the app's report (the caller's own organisation; sane bounds).
--   * get_prosm_time_connect_usage_report: the organisation owner's report - per audio call / video call / meeting,
--     relay minutes vs direct minutes, per relay server, average data per minute.
--   * prosm_time_connect_relay_month / connect_turn_alerts: the platform-wide monthly total per relay server (the
--     quota is one account for every organisation) and the 50/75/90/95 % marks - read and written only by the
--     connect-ice function (service role); no organisation sees another's data.
-- Rollback: drop the two functions for the app, the two platform functions, the alerts and usage tables.

begin;

create table if not exists public.connect_turn_usage (
    id bigserial primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid references public.users(id) on delete set null,
    kind text not null check (kind in ('audio', 'video', 'meeting')),
    ref_id uuid,
    route text not null check (route in ('host', 'srflx', 'prflx', 'relay', 'unknown')),
    server text check (server is null or char_length(server) <= 200),
    bytes bigint not null check (bytes >= 0),
    seconds integer not null check (seconds >= 0),
    created_at timestamptz not null default now()
);
create index if not exists connect_turn_usage_org_created_idx on public.connect_turn_usage (organization_id, created_at);
create index if not exists connect_turn_usage_relay_month_idx on public.connect_turn_usage (server, created_at) where route = 'relay';
alter table public.connect_turn_usage enable row level security;
revoke all on public.connect_turn_usage from anon, authenticated;
-- read through get_prosm_time_connect_usage_report only

create or replace function public.record_prosm_time_connect_usage(p_kind text, p_ref_id uuid, p_route text, p_server text, p_bytes bigint, p_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_server text := nullif(lower(trim(coalesce(p_server, ''))), '');
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if p_kind not in ('audio', 'video', 'meeting') then raise exception 'INVALID KIND'; end if;
    if p_route not in ('host', 'srflx', 'prflx', 'relay', 'unknown') then raise exception 'INVALID ROUTE'; end if;
    -- one report covers at most a few minutes of one connection: reject nonsense instead of storing it
    if p_bytes is null or p_bytes < 0 or p_bytes > 2000000000 or p_seconds is null or p_seconds < 0 or p_seconds > 7200 then
        raise exception 'INVALID USAGE';
    end if;
    if p_route <> 'relay' then v_server := null; end if;
    if p_bytes = 0 and p_seconds = 0 then return jsonb_build_object('success', true); end if;
    insert into connect_turn_usage (organization_id, user_id, kind, ref_id, route, server, bytes, seconds)
    values (v_org, v_me, p_kind, p_ref_id, p_route, left(v_server, 200), p_bytes, p_seconds);
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.record_prosm_time_connect_usage(text, uuid, text, text, bigint, integer) from public, anon;
grant execute on function public.record_prosm_time_connect_usage(text, uuid, text, text, bigint, integer) to authenticated;

create or replace function public.get_prosm_time_connect_usage_report(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_from timestamptz := coalesce(p_from, date_trunc('month', now())::date)::timestamptz;
    v_to timestamptz := (coalesce(p_to, (now() at time zone 'utc')::date) + 1)::timestamptz;
    v_result jsonb;
begin
    if v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER SEES CONNECT USAGE'; end if;
    with u as (
        select * from connect_turn_usage where organization_id = v_org and created_at >= v_from and created_at < v_to
    ),
    by_kind as (
        select kind,
               count(distinct ref_id) as sessions,
               sum(bytes) as bytes,
               sum(bytes) filter (where route = 'relay') as relay_bytes,
               sum(seconds) filter (where route = 'relay') as relay_seconds,
               sum(seconds) filter (where route <> 'relay') as direct_seconds,
               sum(seconds) as seconds
        from u group by kind
    ),
    by_server as (
        select server, sum(bytes) as bytes, sum(seconds) as seconds from u where route = 'relay' group by server
    )
    select jsonb_build_object(
        'from', v_from, 'to', v_to,
        'kinds', coalesce((select jsonb_agg(jsonb_build_object(
            'kind', kind, 'sessions', sessions, 'bytes', coalesce(bytes, 0), 'relayBytes', coalesce(relay_bytes, 0),
            'relayMinutes', round(coalesce(relay_seconds, 0) / 60.0, 1), 'directMinutes', round(coalesce(direct_seconds, 0) / 60.0, 1),
            'bytesPerMinute', case when coalesce(seconds, 0) > 0 then round(bytes * 60.0 / seconds) else 0 end) order by kind) from by_kind), '[]'::jsonb),
        'servers', coalesce((select jsonb_agg(jsonb_build_object('server', server, 'bytes', bytes, 'minutes', round(seconds / 60.0, 1)) order by bytes desc) from by_server), '[]'::jsonb),
        'totalRelayBytes', coalesce((select sum(bytes) from u where route = 'relay'), 0),
        'totalBytes', coalesce((select sum(bytes) from u), 0)
    ) into v_result;
    return v_result;
end;
$$;
revoke all on function public.get_prosm_time_connect_usage_report(date, date) from public, anon;
grant execute on function public.get_prosm_time_connect_usage_report(date, date) to authenticated;

-- platform-wide, for connect-ice only --------------------------------------------------------------------------------
create table if not exists public.connect_turn_alerts (
    month date not null,
    server text not null,
    level integer not null check (level in (50, 75, 90, 95)),
    used_bytes bigint not null,
    quota_bytes bigint not null,
    created_at timestamptz not null default now(),
    primary key (month, server, level)
);
alter table public.connect_turn_alerts enable row level security;
revoke all on public.connect_turn_alerts from anon, authenticated;

create or replace function public.prosm_time_connect_relay_month(p_servers text[])
returns table (server text, used_bytes bigint)
language sql
stable
security definer
set search_path = public
as $$
    select s.server, coalesce((
        select sum(u.bytes) from connect_turn_usage u
        where u.route = 'relay' and u.server = s.server and u.created_at >= date_trunc('month', now())
    ), 0)::bigint
    from unnest(p_servers) as s(server);
$$;
revoke all on function public.prosm_time_connect_relay_month(text[]) from public, anon, authenticated;
grant execute on function public.prosm_time_connect_relay_month(text[]) to service_role;

-- marks a level once a month per server; true only the first time (so a warning goes out once)
create or replace function public.prosm_time_connect_mark_alert(p_server text, p_level integer, p_used bigint, p_quota bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rows integer;
begin
    insert into connect_turn_alerts (month, server, level, used_bytes, quota_bytes)
    values (date_trunc('month', now())::date, p_server, p_level, p_used, p_quota)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    return v_rows > 0;
end;
$$;
revoke all on function public.prosm_time_connect_mark_alert(text, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.prosm_time_connect_mark_alert(text, integer, bigint, bigint) to service_role;

commit;
