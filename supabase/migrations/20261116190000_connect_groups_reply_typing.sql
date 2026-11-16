-- PROSM Connect G5 / G6 (owner 2026-11-15 / 16): groups, reply to a message, "typing...".
--   * Groups: a named conversation of colleagues (2 to 50 people of the same organisation). The creator is its admin;
--     admins add / remove members and rename it; anyone can leave (the last admin leaving hands it to the oldest
--     member). Messages already reach every member (the switchboard's fan-out) - a group call is a small meeting.
--   * Reply: an item can point at the message it answers (reply_to, the client id) with a short snippet - older apps
--     ignore the two columns and show the message as before.
--   * Typing: a live notice to the conversation's other members ('typing' event, nothing stored) - older apps do not
--     listen to it.
-- Rollback: drop the functions below and the two switchboard columns.

begin;

alter table public.connect_switchboard add column if not exists reply_to text check (reply_to is null or length(reply_to) <= 64);
alter table public.connect_switchboard add column if not exists reply_snippet text check (reply_snippet is null or length(reply_snippet) <= 200);

create or replace function public.prosm_time_connect_create_group(p_title text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_title text := nullif(trim(coalesce(p_title, '')), '');
    v_members uuid[];
    v_id uuid;
begin
    if v_me is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_connect_feature(v_org, 'connect_chat') then raise exception 'FEATURE NOT IN PLAN: connect_chat'; end if;
    if v_title is null or length(v_title) > 120 then raise exception 'A GROUP NAME IS REQUIRED'; end if;
    select array_agg(distinct u.id) into v_members from users u
    where u.id = any(coalesce(p_members, '{}')) and u.organization_id = v_org and u.is_active and u.id <> v_me;
    if coalesce(cardinality(v_members), 0) < 1 then raise exception 'CHOOSE AT LEAST ONE MEMBER'; end if;
    if cardinality(v_members) > 49 then raise exception 'A GROUP HAS AT MOST 50 PEOPLE'; end if;
    insert into connect_conversations (organization_id, kind, title, created_by) values (v_org, 'group', v_title, v_me) returning id into v_id;
    insert into connect_conversation_members (conversation_id, user_id, role) values (v_id, v_me, 'admin');
    insert into connect_conversation_members (conversation_id, user_id) select v_id, m from unnest(v_members) m;
    return v_id;
end;
$$;
revoke all on function public.prosm_time_connect_create_group(text, uuid[]) from public, anon;
grant execute on function public.prosm_time_connect_create_group(text, uuid[]) to authenticated;

create or replace function public.prosm_time_connect_group_is_admin(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from connect_conversation_members m join connect_conversations c on c.id = m.conversation_id
                   where m.conversation_id = p_conversation and m.user_id = public.current_prosm_time_user_id() and m.role = 'admin'
                     and c.kind = 'group' and c.organization_id = public.current_prosm_time_organization_id());
$$;
revoke all on function public.prosm_time_connect_group_is_admin(uuid) from public, anon, authenticated;

-- admins: add / remove members, rename
create or replace function public.prosm_time_connect_update_group(p_conversation uuid, p_title text default null, p_add uuid[] default null, p_remove uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_me is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_connect_group_is_admin(p_conversation) then raise exception 'ONLY A GROUP ADMIN'; end if;
    if p_title is not null then
        if length(trim(p_title)) = 0 or length(trim(p_title)) > 120 then raise exception 'A GROUP NAME IS REQUIRED'; end if;
        update connect_conversations set title = trim(p_title) where id = p_conversation;
    end if;
    if p_add is not null then
        insert into connect_conversation_members (conversation_id, user_id)
        select p_conversation, u.id from users u where u.id = any(p_add) and u.organization_id = v_org and u.is_active
        on conflict do nothing;
        if (select count(*) from connect_conversation_members where conversation_id = p_conversation) > 50 then raise exception 'A GROUP HAS AT MOST 50 PEOPLE'; end if;
    end if;
    if p_remove is not null then
        delete from connect_conversation_members where conversation_id = p_conversation and user_id = any(p_remove) and user_id <> v_me;
    end if;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.prosm_time_connect_update_group(uuid, text, uuid[], uuid[]) from public, anon;
grant execute on function public.prosm_time_connect_update_group(uuid, text, uuid[], uuid[]) to authenticated;

create or replace function public.prosm_time_connect_leave_group(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from connect_conversations c join connect_conversation_members m on m.conversation_id = c.id
                   where c.id = p_conversation and c.kind = 'group' and m.user_id = v_me) then
        raise exception 'GROUP NOT FOUND';
    end if;
    delete from connect_conversation_members where conversation_id = p_conversation and user_id = v_me;
    -- a group never stays without an admin while it has members
    if not exists (select 1 from connect_conversation_members where conversation_id = p_conversation and role = 'admin') then
        update connect_conversation_members set role = 'admin'
        where conversation_id = p_conversation and user_id = (select user_id from connect_conversation_members where conversation_id = p_conversation order by joined_at, user_id limit 1);
    end if;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.prosm_time_connect_leave_group(uuid) from public, anon;
grant execute on function public.prosm_time_connect_leave_group(uuid) to authenticated;

-- my groups: name, members and their role (the app shows the group by its name, not as a person)
create or replace function public.list_prosm_time_connect_groups()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'title', c.title, 'createdAt', c.created_at,
               'members', (select jsonb_agg(jsonb_build_object('userId', m2.user_id, 'role', m2.role) order by m2.joined_at) from connect_conversation_members m2 where m2.conversation_id = c.id))
               order by c.created_at desc), '[]'::jsonb)
    from connect_conversations c
    join connect_conversation_members m on m.conversation_id = c.id and m.user_id = public.current_prosm_time_user_id()
    where c.kind = 'group' and c.organization_id = public.current_prosm_time_organization_id();
$$;
revoke all on function public.list_prosm_time_connect_groups() from public, anon;
grant execute on function public.list_prosm_time_connect_groups() to authenticated;

-- "typing...": a live notice to the other members (nothing stored)
create or replace function public.prosm_time_connect_typing(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_to uuid;
begin
    if v_me is null then return; end if;
    if not exists (select 1 from connect_conversation_members where conversation_id = p_conversation and user_id = v_me) then return; end if;
    for v_to in select user_id from connect_conversation_members where conversation_id = p_conversation and user_id <> v_me loop
        perform public.prosm_time_connect_notify(v_to, 'typing', jsonb_build_object('from', v_me, 'conversationId', p_conversation));
    end loop;
end;
$$;
revoke all on function public.prosm_time_connect_typing(uuid) from public, anon;
grant execute on function public.prosm_time_connect_typing(uuid) to authenticated;

commit;
