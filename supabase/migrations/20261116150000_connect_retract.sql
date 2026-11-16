-- PROSM Connect (owner 2026-11-16: "delete messages"): delete my own message FOR EVERYONE.
-- Messages live on each device, so a deletion is a notice the other devices act on. It does not travel as a
-- switchboard item: an older app would show an unknown item as a message. It is kept in connect_retractions (read by
-- newer apps when they open or reconnect) and announced live on an event older apps do not listen to ('retract').
-- A copy not yet fetched by its recipient is removed from the switchboard, so it never arrives.
-- The receiving app removes a message only if it came from the person who sent the notice - nobody can delete
-- someone else's message. Notices are kept 14 days.
-- Rollback: drop prosm_time_connect_retract, list_prosm_time_connect_retractions and connect_retractions.

begin;

create table if not exists public.connect_retractions (
    id bigserial primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    from_user uuid not null references public.users(id) on delete cascade,
    conversation_id uuid references public.connect_conversations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    client_ids text[] not null check (cardinality(client_ids) between 1 and 50),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '14 days',
    check (num_nonnulls(conversation_id, site_id) = 1)
);
create index if not exists connect_retractions_conversation on public.connect_retractions (conversation_id, created_at);
create index if not exists connect_retractions_site on public.connect_retractions (site_id, created_at);
alter table public.connect_retractions enable row level security;
revoke all on public.connect_retractions from anon, authenticated;

create or replace function public.prosm_time_connect_retract(p_conversation uuid, p_site uuid, p_client_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_to uuid;
    v_payload jsonb;
begin
    if v_me is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if num_nonnulls(p_conversation, p_site) <> 1 then raise exception 'ONE CONVERSATION OR ONE SITE'; end if;
    if p_client_ids is null or cardinality(p_client_ids) not between 1 and 50
       or exists (select 1 from unnest(p_client_ids) c where c is null or length(c) > 64) then
        raise exception 'INVALID MESSAGES';
    end if;
    if p_conversation is not null and not exists (
        select 1 from connect_conversations c join connect_conversation_members m on m.conversation_id = c.id
        where c.id = p_conversation and c.organization_id = v_org and m.user_id = v_me
    ) then raise exception 'CONVERSATION NOT FOUND'; end if;
    if p_site is not null and not exists (select 1 from sites where id = p_site and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    -- copies not fetched yet never arrive
    delete from connect_switchboard where from_user = v_me and client_id = any(p_client_ids);

    insert into connect_retractions (organization_id, from_user, conversation_id, site_id, client_ids)
    values (v_org, v_me, p_conversation, p_site, p_client_ids);

    v_payload := jsonb_build_object('from', v_me, 'conversationId', p_conversation, 'siteId', p_site, 'clientIds', to_jsonb(p_client_ids), 'createdAt', now());
    for v_to in
        select m.user_id from connect_conversation_members m where p_conversation is not null and m.conversation_id = p_conversation and m.user_id <> v_me
        union
        select a.user_id from site_assignments a where p_site is not null and a.site_id = p_site and a.user_id <> v_me
    loop
        perform public.prosm_time_connect_notify(v_to, 'retract', v_payload);
    end loop;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.prosm_time_connect_retract(uuid, uuid, text[]) from public, anon;
grant execute on function public.prosm_time_connect_retract(uuid, uuid, text[]) to authenticated;

-- the notices meant for me since a moment (my conversations, and my organisation's sites)
create or replace function public.list_prosm_time_connect_retractions(p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'from', r.from_user, 'conversationId', r.conversation_id, 'siteId', r.site_id,
               'clientIds', to_jsonb(r.client_ids), 'createdAt', r.created_at) order by r.created_at), '[]'::jsonb)
    from connect_retractions r
    where r.organization_id = public.current_prosm_time_organization_id()
      and r.from_user <> public.current_prosm_time_user_id()
      and r.expires_at > now()
      and r.created_at > coalesce(p_since, now() - interval '14 days')
      and (
          (r.conversation_id is not null and exists (select 1 from connect_conversation_members m where m.conversation_id = r.conversation_id and m.user_id = public.current_prosm_time_user_id()))
          or r.site_id is not null
      );
$$;
revoke all on function public.list_prosm_time_connect_retractions(timestamptz) from public, anon;
grant execute on function public.list_prosm_time_connect_retractions(timestamptz) to authenticated;

commit;
