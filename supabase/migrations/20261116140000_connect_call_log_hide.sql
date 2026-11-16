-- PROSM Connect (owner 2026-11-14 / 2026-11-16: "delete messages, chats and the call log"): a person clears calls
-- from THEIR call log - one, several, or all. The organisation's record of the call stays (who called whom, when,
-- how long - it can matter later); it is only hidden from that person's own list. The other person's log is
-- untouched. Messages and chats live on the device and are deleted there (no server change).
-- Rollback: re-run list_prosm_time_connect_calls from 20261114120000; drop prosm_time_connect_hide_calls and
-- connect_call_hidden.

begin;

create table if not exists public.connect_call_hidden (
    user_id uuid not null references public.users(id) on delete cascade,
    call_id uuid not null references public.connect_calls(id) on delete cascade,
    hidden_at timestamptz not null default now(),
    primary key (user_id, call_id)
);
alter table public.connect_call_hidden enable row level security;
revoke all on public.connect_call_hidden from anon, authenticated;

-- p_call_ids null = every call in my log
create or replace function public.prosm_time_connect_hide_calls(p_call_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_count integer;
begin
    if v_me is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    insert into connect_call_hidden (user_id, call_id)
    select v_me, c.id from connect_calls c
    where c.organization_id = v_org and v_me in (c.caller_id, c.callee_id)
      and (p_call_ids is null or c.id = any(p_call_ids))
    on conflict do nothing;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;
revoke all on function public.prosm_time_connect_hide_calls(uuid[]) from public, anon;
grant execute on function public.prosm_time_connect_hide_calls(uuid[]) to authenticated;

create or replace function public.list_prosm_time_connect_calls()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'media', c.media, 'status', c.status, 'outgoing', c.caller_id = public.current_prosm_time_user_id(),
               'otherId', case when c.caller_id = public.current_prosm_time_user_id() then c.callee_id else c.caller_id end,
               'createdAt', c.created_at, 'answeredAt', c.answered_at, 'endedAt', c.ended_at) order by c.created_at desc), '[]'::jsonb)
    from connect_calls c
    where public.current_prosm_time_user_id() in (c.caller_id, c.callee_id)
      and c.organization_id = public.current_prosm_time_organization_id()
      and not exists (select 1 from connect_call_hidden h where h.user_id = public.current_prosm_time_user_id() and h.call_id = c.id);
$$;
revoke all on function public.list_prosm_time_connect_calls() from public, anon;
grant execute on function public.list_prosm_time_connect_calls() to authenticated;

commit;
