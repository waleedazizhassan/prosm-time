-- Owner 2026-11-13: the map-link reader (resolve-map-link) may be published on condition that it takes Google links
-- only, answers signed-in people only, and has a limit on how many requests it serves. This is the limit: a small
-- counter per person and action, in fixed windows. The function asks before each request; over the limit it says no.
-- Old windows are removed as new ones are counted. Usable by later functions too (each with its own action name).
-- Rollback: drop function prosm_time_take_rate_limit and table rate_limit_hits.

begin;

create table if not exists public.rate_limit_hits (
    user_id uuid not null references public.users(id) on delete cascade,
    action text not null,
    window_start timestamptz not null,
    hits integer not null default 0,
    primary key (user_id, action, window_start)
);
alter table public.rate_limit_hits enable row level security;
-- no policies: only the function below reads or writes it
revoke all on public.rate_limit_hits from public, anon, authenticated;

-- true = this request may go ahead (and is counted); false = over the limit for this window
create or replace function public.prosm_time_take_rate_limit(p_action text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_start timestamptz;
    v_hits integer;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action is null or length(p_action) > 60 or p_max < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
        raise exception 'INVALID RATE LIMIT';
    end if;
    v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
    delete from rate_limit_hits where user_id = v_me and action = p_action and window_start < v_start;
    insert into rate_limit_hits (user_id, action, window_start, hits) values (v_me, p_action, v_start, 1)
    on conflict (user_id, action, window_start) do update set hits = rate_limit_hits.hits + 1
    returning hits into v_hits;
    return v_hits <= p_max;
end;
$$;
revoke all on function public.prosm_time_take_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.prosm_time_take_rate_limit(text, integer, integer) to authenticated;

commit;
