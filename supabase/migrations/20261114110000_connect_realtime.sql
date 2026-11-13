-- PROSM Connect - stage 1: private Realtime channels (owner 2026-11-13: approved). Who may join which channel:
--   connect:user:<user id>        the person themselves - the switchboard's new requests for them
--   connect:call:<call id>        the call's two people - offer / answer / ice / hangup, broadcast, never stored
--   connect:meeting:<meeting id>  the meeting's host and people - its signals and who is present
--   connect:conv:<conversation id> the conversation's members - "typing" and "seen"
--   connect:company:<organisation id> the organisation's people - who is online
-- and only while the organisation has Connect. Rules on realtime.messages (Supabase Realtime Authorization), for
-- private channels only; nothing else in the app uses private channels, and the notification bell (postgres
-- changes) is not affected. A new switchboard request is sent to each recipient's channel at once (realtime.send).
-- This part needs Supabase's realtime schema; where it does not exist (the test database) it is skipped, and its
-- rules are tested against a local Supabase (supabase/tests-realtime).
-- Rollback: drop the two policies "connect private channels ..." on realtime.messages, the trigger
-- connect_switchboard_realtime and the functions prosm_time_connect_can_join and prosm_time_connect_push_realtime.

begin;

create or replace function public.prosm_time_connect_can_join(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_kind text;
    v_id text;
begin
    if v_me is null or p_topic is null or p_topic not like 'connect:%' then return false; end if;
    if not public.prosm_time_connect_enabled(v_org) then return false; end if;
    v_kind := split_part(p_topic, ':', 2);
    v_id := split_part(p_topic, ':', 3);
    if split_part(p_topic, ':', 4) <> '' or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    return case v_kind
        when 'user' then v_id = v_me::text
        when 'company' then v_id = v_org::text
        when 'conv' then public.prosm_time_connect_is_member(v_id::uuid, v_me)
        when 'call' then exists (select 1 from connect_calls c where c.id = v_id::uuid and c.organization_id = v_org and v_me in (c.caller_id, c.callee_id))
        when 'meeting' then exists (select 1 from connect_meetings m where m.id = v_id::uuid and m.organization_id = v_org)
                            and public.prosm_time_connect_meeting_party(v_id::uuid, v_me)
        else false
    end;
end;
$$;
revoke all on function public.prosm_time_connect_can_join(text) from public, anon;
grant execute on function public.prosm_time_connect_can_join(text) to authenticated;

-- each recipient's channel hears of a new request at once (the content stays in the row, read under its rules)
create or replace function public.prosm_time_connect_push_realtime()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_to uuid;
begin
    if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then return new; end if;
    for v_to in select recipient_id from connect_receipts where item_id = new.id loop
        begin
            perform realtime.send(
                jsonb_build_object('id', new.id, 'type', new.type, 'from', new.from_user, 'conversationId', new.conversation_id,
                                   'siteId', new.site_id, 'refId', new.ref_id, 'createdAt', new.created_at),
                'item', 'connect:user:' || v_to::text, true);
        exception when others then
            null; -- a missed live notice is caught by the inbox on the next open
        end;
    end loop;
    return new;
end;
$$;
revoke all on function public.prosm_time_connect_push_realtime() from public, anon, authenticated;

-- after the fan-out trigger (triggers run in name order: ..._fan_out before ..._realtime)
drop trigger if exists connect_switchboard_realtime on public.connect_switchboard;
create trigger connect_switchboard_realtime after insert on public.connect_switchboard
    for each row execute function public.prosm_time_connect_push_realtime();

do $$
begin
    if to_regclass('realtime.messages') is not null then
        execute 'drop policy if exists "connect private channels read" on realtime.messages';
        execute 'create policy "connect private channels read" on realtime.messages for select to authenticated
                 using (public.prosm_time_connect_can_join((select realtime.topic())))';
        execute 'drop policy if exists "connect private channels write" on realtime.messages';
        execute 'create policy "connect private channels write" on realtime.messages for insert to authenticated
                 with check (public.prosm_time_connect_can_join((select realtime.topic())))';
    end if;
end $$;

commit;
