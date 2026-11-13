-- PROSM Connect - stage 1: the foundation (owner 2026-11-13, PROSM_Connect_Implementation.md, decisions of the
-- same day). A module inside PROSM Time: the server is the switchboard (001) - it carries a request to the right
-- person and lets go; the content travels between devices (WebRTC) or waits in a temporary bucket for someone
-- offline, and is deleted once received, or after 7 days at most. Everything stays inside one organisation.
--   * Plans: connect_chat, connect_camera_photo, connect_calls, connect_site_broadcast (Business and up),
--     connect_push_to_talk, connect_meetings, connect_screen_share, connect_meeting_recording (Pro and up);
--     Starter has none for now (add-ons later); a trial and 'legacy' keep everything, as with every feature.
--   * Internal numbers (connect_extensions): one per person, unique in the organisation, from 10; 001 is the
--     switchboard's and can never be given.
--   * Tables (connect_*, organization_id, people are public.users): conversations and members, the switchboard,
--     receipts, calls, meetings and their peers, photo proofs (text only, never the photo), a storage trash queue.
--   * Row security on every table: same organisation, the module on, the sender is the signed-in person, each
--     reads only what is addressed to them (or their conversations); changes go through the functions only.
--   * push_devices takes the 'desktop' platform (the call token waits for an iOS app).
--   * Bucket connect-temp: private, 100 MB, a sender's upload in <organisation>/<item>/, read by the item's people.
--   * Cleanup every hour (pg_cron): expired rows, ringing calls over 45 s, open calls over 6 h, meetings a day after
--     they end; files of removed rows are queued for the connect-cleanup function (deleting storage.objects in SQL
--     does not delete the file).
-- Realtime (private channels) is in the next migration, apart, as it needs Supabase's realtime schema.
-- Rollback: unschedule 'prosm-time-connect-cleanup'; drop the connect_* tables and prosm_time_connect_* functions,
-- the users trigger connect_extension_on_join, the bucket's policies and the bucket; restore push_devices'
-- platform check to ('android', 'ios', 'web'); remove the connect_* keys from plans.feature_flags.

begin;

-- 1. Plans ------------------------------------------------------------------------------------------------------
update public.plans set feature_flags = feature_flags || '{"connect_chat": true, "connect_camera_photo": true, "connect_calls": true, "connect_site_broadcast": true}'::jsonb
where key = 'business';
update public.plans set feature_flags = feature_flags || '{"connect_chat": true, "connect_camera_photo": true, "connect_calls": true, "connect_site_broadcast": true, "connect_push_to_talk": true, "connect_meetings": true, "connect_screen_share": true, "connect_meeting_recording": true}'::jsonb
where key in ('pro', 'enterprise', 'legacy');

-- the largest file a plan allows (MB); 100 unless a plan says otherwise in feature_flags.connect_max_file_mb
create or replace function public.prosm_time_connect_max_file_mb(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select (p.feature_flags ->> 'connect_max_file_mb')::integer
                     from entitlements e join plans p on p.key = e.plan where e.organization_id = p_org), 100);
$$;
revoke all on function public.prosm_time_connect_max_file_mb(uuid) from public, anon, authenticated;

-- a Connect feature for an organisation: its plan allows it, and the organisation is not locked
create or replace function public.prosm_time_connect_feature(p_org uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select p_org is not null and p_feature like 'connect\_%'
       and public.prosm_time_plan_allows(p_org, p_feature)
       and not public.prosm_time_org_locked(p_org);
$$;
revoke all on function public.prosm_time_connect_feature(uuid, text) from public, anon;
-- read by the row rules below (a yes or no only)
grant execute on function public.prosm_time_connect_feature(uuid, text) to authenticated;

-- the module is on: at least the chat (every plan that has Connect has the chat)
create or replace function public.prosm_time_connect_enabled(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_connect_feature(p_org, 'connect_chat');
$$;
revoke all on function public.prosm_time_connect_enabled(uuid) from public, anon;
-- read by the row rules below (a yes or no only)
grant execute on function public.prosm_time_connect_enabled(uuid) to authenticated;

-- 2. Internal numbers -------------------------------------------------------------------------------------------
create table public.connect_extensions (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    ext text not null check (ext ~ '^[0-9]{2,6}$' and ext <> '001'),
    created_at timestamptz not null default now(),
    primary key (organization_id, user_id),
    unique (organization_id, ext),
    unique (user_id)
);
alter table public.connect_extensions enable row level security;

-- what the signed-in person's organisation has of Connect (for the screens; the server checks again)
create or replace function public.get_prosm_time_connect_features()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'enabled', public.prosm_time_connect_enabled(o),
        'chat', public.prosm_time_connect_feature(o, 'connect_chat'),
        'cameraPhoto', public.prosm_time_connect_feature(o, 'connect_camera_photo'),
        'calls', public.prosm_time_connect_feature(o, 'connect_calls'),
        'siteBroadcast', public.prosm_time_connect_feature(o, 'connect_site_broadcast'),
        'pushToTalk', public.prosm_time_connect_feature(o, 'connect_push_to_talk'),
        'meetings', public.prosm_time_connect_feature(o, 'connect_meetings'),
        'screenShare', public.prosm_time_connect_feature(o, 'connect_screen_share'),
        'meetingRecording', public.prosm_time_connect_feature(o, 'connect_meeting_recording'),
        'maxFileMb', public.prosm_time_connect_max_file_mb(o),
        'myExtension', (select x.ext from connect_extensions x where x.user_id = public.current_prosm_time_user_id())
    )
    from (select public.current_prosm_time_organization_id() as o) org;
$$;
revoke all on function public.get_prosm_time_connect_features() from public, anon;
grant execute on function public.get_prosm_time_connect_features() to authenticated;

-- the smallest free number from 10 in the organisation
create or replace function public.prosm_time_connect_next_ext(p_org uuid)
returns text
language sql
volatile
security definer
set search_path = public
as $$
    select min(n)::text from generate_series(10, 999999) n
    where not exists (select 1 from connect_extensions x where x.organization_id = p_org and x.ext = n::text)
    limit 1;
$$;
revoke all on function public.prosm_time_connect_next_ext(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_connect_extension_on_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    perform pg_advisory_xact_lock(hashtext('connect_ext:' || new.organization_id::text));
    insert into connect_extensions (organization_id, user_id, ext)
    values (new.organization_id, new.id, public.prosm_time_connect_next_ext(new.organization_id))
    on conflict (user_id) do nothing;
    return new;
end;
$$;
revoke all on function public.prosm_time_connect_extension_on_join() from public, anon, authenticated;

drop trigger if exists connect_extension_on_join on public.users;
create trigger connect_extension_on_join after insert on public.users
    for each row execute function public.prosm_time_connect_extension_on_join();

-- everyone there today, in the order they joined
do $$
declare r record;
begin
    for r in select id, organization_id from public.users order by organization_id, created_at, id loop
        insert into public.connect_extensions (organization_id, user_id, ext)
        values (r.organization_id, r.id, public.prosm_time_connect_next_ext(r.organization_id))
        on conflict (user_id) do nothing;
    end loop;
end $$;

-- 3. Conversations ----------------------------------------------------------------------------------------------
create table public.connect_conversations (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    kind text not null check (kind in ('direct', 'group', 'site')),
    site_id uuid references public.sites(id) on delete cascade,
    title text check (title is null or length(title) <= 120),
    direct_key text,
    created_by uuid not null references public.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    check ((kind = 'site') = (site_id is not null)),
    check ((kind = 'direct') = (direct_key is not null))
);
create unique index connect_conversations_direct on public.connect_conversations (organization_id, direct_key) where direct_key is not null;
create unique index connect_conversations_site on public.connect_conversations (organization_id, site_id) where kind = 'site';
alter table public.connect_conversations enable row level security;

create table public.connect_conversation_members (
    conversation_id uuid not null references public.connect_conversations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    role text not null default 'member' check (role in ('member', 'admin')),
    joined_at timestamptz not null default now(),
    primary key (conversation_id, user_id)
);
create index connect_conversation_members_user on public.connect_conversation_members (user_id);
alter table public.connect_conversation_members enable row level security;

create or replace function public.prosm_time_connect_is_member(p_conversation uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from connect_conversation_members m where m.conversation_id = p_conversation and m.user_id = p_user);
$$;
revoke all on function public.prosm_time_connect_is_member(uuid, uuid) from public, anon;
-- read by the row rules below (a yes or no only)
grant execute on function public.prosm_time_connect_is_member(uuid, uuid) to authenticated;

-- 4. The switchboard (001) --------------------------------------------------------------------------------------
create table public.connect_switchboard (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    from_user uuid not null references public.users(id) on delete cascade,
    to_user uuid references public.users(id) on delete cascade,
    conversation_id uuid references public.connect_conversations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    type text not null check (type in (
        'message', 'image', 'camera_photo', 'file', 'voice_note', 'push_to_talk',
        'site_broadcast', 'photo_request',
        'audio_call', 'video_call', 'meeting_invite',
        'accept', 'reject', 'busy', 'end', 'missed')),
    body text check (body is null or length(body) <= 4000),
    ref_id uuid,
    client_id text check (client_id is null or length(client_id) <= 64),
    attachment_path text check (attachment_path is null or length(attachment_path) <= 400),
    mime_type text check (mime_type is null or length(mime_type) <= 120),
    size_bytes bigint check (size_bytes is null or size_bytes >= 0),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '7 days',
    check (num_nonnulls(to_user, conversation_id, site_id) = 1)
);
create index connect_switchboard_to on public.connect_switchboard (to_user, created_at);
create index connect_switchboard_conversation on public.connect_switchboard (conversation_id, created_at);
create index connect_switchboard_expires on public.connect_switchboard (expires_at);
create unique index connect_switchboard_client on public.connect_switchboard (from_user, client_id) where client_id is not null;
alter table public.connect_switchboard enable row level security;

create table public.connect_receipts (
    item_id uuid not null references public.connect_switchboard(id) on delete cascade,
    recipient_id uuid not null references public.users(id) on delete cascade,
    delivered_at timestamptz,
    read_at timestamptz,
    primary key (item_id, recipient_id)
);
create index connect_receipts_recipient on public.connect_receipts (recipient_id) where delivered_at is null;
alter table public.connect_receipts enable row level security;

-- which plan feature each kind of request needs
create or replace function public.prosm_time_connect_type_feature(p_type text)
returns text
language sql
immutable
set search_path = public
as $$
    select case
        when p_type in ('message', 'image', 'file', 'voice_note') then 'connect_chat'
        when p_type in ('camera_photo', 'photo_request') then 'connect_camera_photo'
        when p_type in ('audio_call', 'video_call', 'accept', 'reject', 'busy', 'end', 'missed') then 'connect_calls'
        when p_type = 'site_broadcast' then 'connect_site_broadcast'
        when p_type = 'push_to_talk' then 'connect_push_to_talk'
        when p_type = 'meeting_invite' then 'connect_meetings'
    end;
$$;
revoke all on function public.prosm_time_connect_type_feature(text) from public, anon, authenticated;

-- a person may send a request: the signed-in sender, the module and the feature on, the addressee in the same
-- organisation (a person, one of their conversations, or one of the organisation's sites)
create or replace function public.prosm_time_connect_may_send(
    p_id uuid, p_org uuid, p_from uuid, p_to uuid, p_conversation uuid, p_site uuid, p_type text, p_expires timestamptz, p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select p_from = public.current_prosm_time_user_id()
       and p_org = public.current_prosm_time_organization_id()
       and public.prosm_time_connect_feature(p_org, public.prosm_time_connect_type_feature(p_type))
       and p_expires <= now() + interval '7 days 1 minute'
       and (
           (p_to is not null and p_to <> p_from
            and exists (select 1 from users u where u.id = p_to and u.organization_id = p_org and u.is_active))
           or (p_conversation is not null and public.prosm_time_connect_is_member(p_conversation, p_from))
           or (p_site is not null and exists (select 1 from sites s where s.id = p_site and s.organization_id = p_org))
       )
       and (p_path is null or p_path like p_org::text || '/' || p_id::text || '/%');
$$;
revoke all on function public.prosm_time_connect_may_send(uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz, text) from public, anon;
grant execute on function public.prosm_time_connect_may_send(uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz, text) to authenticated;

-- one of an item's people (its sender or a recipient) - a helper for the rules below, so that the tables' rules
-- never read each other in a loop
create or replace function public.prosm_time_connect_item_party(p_item uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from connect_switchboard s where s.id = p_item and s.from_user = p_user)
        or exists (select 1 from connect_receipts r where r.item_id = p_item and r.recipient_id = p_user);
$$;
revoke all on function public.prosm_time_connect_item_party(uuid, uuid) from public, anon;
grant execute on function public.prosm_time_connect_item_party(uuid, uuid) to authenticated;

-- who receives a request, fixed when it is sent: the person; the conversation's other members; or the people
-- present at the site at that moment (an open attendance session there)
create or replace function public.prosm_time_connect_fan_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.to_user is not null then
        insert into connect_receipts (item_id, recipient_id) values (new.id, new.to_user) on conflict do nothing;
    elsif new.conversation_id is not null then
        insert into connect_receipts (item_id, recipient_id)
        select new.id, m.user_id from connect_conversation_members m
        where m.conversation_id = new.conversation_id and m.user_id <> new.from_user
        on conflict do nothing;
    else
        insert into connect_receipts (item_id, recipient_id)
        select distinct new.id, a.user_id from attendance_sessions a
        join users u on u.id = a.user_id and u.is_active
        where a.site_id = new.site_id and a.status = 'clocked_in' and a.user_id <> new.from_user
        on conflict do nothing;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_connect_fan_out() from public, anon, authenticated;
create trigger connect_switchboard_fan_out after insert on public.connect_switchboard
    for each row execute function public.prosm_time_connect_fan_out();

-- 5. Calls and meetings (their state and log, not their signals) ------------------------------------------------
create table public.connect_calls (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    caller_id uuid not null references public.users(id) on delete cascade,
    callee_id uuid not null references public.users(id) on delete cascade,
    media text not null check (media in ('audio', 'video')),
    status text not null default 'ringing' check (status in ('ringing', 'accepted', 'ended', 'missed', 'rejected', 'busy', 'failed')),
    created_at timestamptz not null default now(),
    answered_at timestamptz,
    ended_at timestamptz,
    expires_at timestamptz not null default now() + interval '24 hours',
    check (caller_id <> callee_id)
);
create index connect_calls_callee on public.connect_calls (callee_id, created_at);
create index connect_calls_caller on public.connect_calls (caller_id, created_at);
alter table public.connect_calls enable row level security;

create table public.connect_meetings (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    host_id uuid not null references public.users(id) on delete cascade,
    media text not null check (media in ('audio', 'video')),
    max_peers integer not null check (max_peers between 2 and 8),
    recording_allowed boolean not null default true,
    status text not null default 'live' check (status in ('live', 'ended')),
    created_at timestamptz not null default now(),
    ended_at timestamptz,
    expires_at timestamptz,
    check ((media = 'video' and max_peers <= 4) or (media = 'audio' and max_peers <= 8))
);
alter table public.connect_meetings enable row level security;

create table public.connect_meeting_peers (
    meeting_id uuid not null references public.connect_meetings(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    joined_at timestamptz not null default now(),
    left_at timestamptz,
    primary key (meeting_id, user_id)
);
alter table public.connect_meeting_peers enable row level security;

create or replace function public.prosm_time_connect_meeting_party(p_meeting uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from connect_meetings m where m.id = p_meeting and m.host_id = p_user)
        or exists (select 1 from connect_meeting_peers p where p.meeting_id = p_meeting and p.user_id = p_user);
$$;
revoke all on function public.prosm_time_connect_meeting_party(uuid, uuid) from public, anon;
grant execute on function public.prosm_time_connect_meeting_party(uuid, uuid) to authenticated;

-- 6. Photo proofs (a short text: never the photo) ---------------------------------------------------------------
create table public.connect_photo_proofs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    code text not null unique,
    site_id uuid references public.sites(id) on delete set null,
    inside_site boolean not null,
    lat double precision not null,
    lng double precision not null,
    accuracy_m real,
    server_time timestamptz not null default now(),
    image_sha256 text check (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now()
);
alter table public.connect_photo_proofs enable row level security;

-- 7. Files waiting to be removed from storage -------------------------------------------------------------------
create table public.connect_storage_trash (
    path text primary key,
    queued_at timestamptz not null default now()
);
alter table public.connect_storage_trash enable row level security;
revoke all on public.connect_storage_trash from public, anon, authenticated;

-- 8. Row security ------------------------------------------------------------------------------------------------
-- reading: same organisation and the module on, plus what is one's own or addressed to one
create policy connect_extensions_read on public.connect_extensions for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id));

create policy connect_conversations_read on public.connect_conversations for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id)
       and public.prosm_time_connect_is_member(id, public.current_prosm_time_user_id()));

create policy connect_conversation_members_read on public.connect_conversation_members for select to authenticated
using (public.prosm_time_connect_is_member(conversation_id, public.current_prosm_time_user_id())
       and exists (select 1 from connect_conversations c where c.id = conversation_id
                   and c.organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(c.organization_id)));

create policy connect_switchboard_read on public.connect_switchboard for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id)
       and (from_user = public.current_prosm_time_user_id() or public.prosm_time_connect_item_party(id, public.current_prosm_time_user_id())));

create policy connect_switchboard_send on public.connect_switchboard for insert to authenticated
with check (public.prosm_time_connect_may_send(id, organization_id, from_user, to_user, conversation_id, site_id, type, expires_at, attachment_path));

create policy connect_receipts_read on public.connect_receipts for select to authenticated
using (public.prosm_time_connect_item_party(item_id, public.current_prosm_time_user_id()));

create policy connect_calls_read on public.connect_calls for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id)
       and public.current_prosm_time_user_id() in (caller_id, callee_id));

create policy connect_meetings_read on public.connect_meetings for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id)
       and public.prosm_time_connect_meeting_party(id, public.current_prosm_time_user_id()));

create policy connect_meeting_peers_read on public.connect_meeting_peers for select to authenticated
using (public.prosm_time_connect_meeting_party(meeting_id, public.current_prosm_time_user_id())
       and public.prosm_time_connect_enabled(public.current_prosm_time_organization_id()));

-- a proof is seen by the person who took it, and by whoever sees attendance in the organisation
create policy connect_photo_proofs_read on public.connect_photo_proofs for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.prosm_time_connect_enabled(organization_id)
       and (user_id = public.current_prosm_time_user_id()
            or public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))));

revoke insert, update, delete on public.connect_extensions, public.connect_conversations, public.connect_conversation_members,
    public.connect_receipts, public.connect_calls, public.connect_meetings, public.connect_meeting_peers, public.connect_photo_proofs
    from anon, authenticated;
revoke update, delete on public.connect_switchboard from anon, authenticated;
revoke all on public.connect_extensions, public.connect_conversations, public.connect_conversation_members, public.connect_switchboard,
    public.connect_receipts, public.connect_calls, public.connect_meetings, public.connect_meeting_peers, public.connect_photo_proofs from anon;

-- 9. The functions the app calls --------------------------------------------------------------------------------
-- a direct conversation with someone in the organisation (found again if it exists)
create or replace function public.prosm_time_connect_open_direct(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_key text;
    v_id uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_connect_enabled(v_org) then raise exception 'FEATURE NOT IN PLAN: connect_chat'; end if;
    if p_other = v_me or not exists (select 1 from users where id = p_other and organization_id = v_org and is_active) then
        raise exception 'USER NOT FOUND';
    end if;
    v_key := least(v_me::text, p_other::text) || ':' || greatest(v_me::text, p_other::text);
    select id into v_id from connect_conversations where organization_id = v_org and direct_key = v_key;
    if v_id is null then
        insert into connect_conversations (organization_id, kind, direct_key, created_by)
        values (v_org, 'direct', v_key, v_me)
        on conflict (organization_id, direct_key) where direct_key is not null do update set direct_key = excluded.direct_key
        returning id into v_id;
        insert into connect_conversation_members (conversation_id, user_id) values (v_id, v_me), (v_id, p_other) on conflict do nothing;
    end if;
    return v_id;
end;
$$;
revoke all on function public.prosm_time_connect_open_direct(uuid) from public, anon;
grant execute on function public.prosm_time_connect_open_direct(uuid) to authenticated;

-- "received": the request is the recipient's now; once everyone has it, the server lets it go (its file too)
create or replace function public.prosm_time_connect_ack(p_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_path text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    update connect_receipts set delivered_at = coalesce(delivered_at, now())
    where item_id = p_item_id and recipient_id = v_me;
    if not found then return false; end if;
    if not exists (select 1 from connect_receipts where item_id = p_item_id and delivered_at is null) then
        delete from connect_switchboard where id = p_item_id returning attachment_path into v_path;
        if v_path is not null then insert into connect_storage_trash (path) values (v_path) on conflict do nothing; end if;
    end if;
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_ack(uuid) from public, anon;
grant execute on function public.prosm_time_connect_ack(uuid) to authenticated;

-- requests waiting for me (what Realtime or a push did not bring, e.g. after being offline)
create or replace function public.list_prosm_time_connect_inbox(p_limit integer default 200)
returns setof public.connect_switchboard
language sql
stable
security definer
set search_path = public
as $$
    select s.* from connect_switchboard s
    join connect_receipts r on r.item_id = s.id and r.recipient_id = public.current_prosm_time_user_id() and r.delivered_at is null
    where s.organization_id = public.current_prosm_time_organization_id()
      and public.prosm_time_connect_enabled(s.organization_id)
      and s.expires_at > now()
    order by s.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;
revoke all on function public.list_prosm_time_connect_inbox(integer) from public, anon;
grant execute on function public.list_prosm_time_connect_inbox(integer) to authenticated;

-- joining a meeting: refused once it is full (4 with video, 8 with sound only) - the same for every plan
create or replace function public.prosm_time_connect_join_meeting(p_meeting_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_meeting connect_meetings%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_meeting from connect_meetings where id = p_meeting_id for update;
    if v_meeting.id is null or v_meeting.organization_id <> public.current_prosm_time_organization_id() then raise exception 'MEETING NOT FOUND'; end if;
    if not public.prosm_time_connect_feature(v_meeting.organization_id, 'connect_meetings') then raise exception 'FEATURE NOT IN PLAN: connect_meetings'; end if;
    if v_meeting.status <> 'live' then raise exception 'THIS MEETING HAS ENDED'; end if;
    if exists (select 1 from connect_meeting_peers where meeting_id = p_meeting_id and user_id = v_me and left_at is null) then return true; end if;
    if (select count(*) from connect_meeting_peers where meeting_id = p_meeting_id and left_at is null) >= v_meeting.max_peers then
        raise exception 'THIS MEETING IS FULL';
    end if;
    insert into connect_meeting_peers (meeting_id, user_id) values (p_meeting_id, v_me)
    on conflict (meeting_id, user_id) do update set left_at = null, joined_at = now();
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_join_meeting(uuid) from public, anon;
grant execute on function public.prosm_time_connect_join_meeting(uuid) to authenticated;

-- 10. push_devices: the computer app ------------------------------------------------------------------------------
alter table public.push_devices drop constraint if exists push_devices_platform_check;
alter table public.push_devices add constraint push_devices_platform_check check (platform in ('android', 'ios', 'web', 'desktop'));

-- 11. The temporary bucket ----------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('connect-temp', 'connect-temp', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "connect sender uploads to its item" on storage.objects;
create policy "connect sender uploads to its item" on storage.objects for insert to authenticated
with check (
    bucket_id = 'connect-temp'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and public.prosm_time_connect_enabled(public.current_prosm_time_organization_id())
    and exists (select 1 from public.connect_switchboard s
                where s.id::text = (storage.foldername(name))[2] and s.from_user = public.current_prosm_time_user_id())
);

drop policy if exists "connect item people read its file" on storage.objects;
create policy "connect item people read its file" on storage.objects for select to authenticated
using (
    bucket_id = 'connect-temp'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
    and public.prosm_time_connect_item_party(((storage.foldername(name))[2])::uuid, public.current_prosm_time_user_id())
);

-- 12. Cleanup every hour ------------------------------------------------------------------------------------------
create or replace function public.prosm_time_connect_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_items integer;
    v_missed integer;
    v_ended integer;
    v_calls integer;
    v_meetings integer;
    v_trash integer;
begin
    with gone as (delete from connect_switchboard where expires_at <= now() returning attachment_path)
    insert into connect_storage_trash (path) select attachment_path from gone where attachment_path is not null on conflict do nothing;
    get diagnostics v_items = row_count;
    update connect_calls set status = 'missed', ended_at = now() where status = 'ringing' and created_at < now() - interval '45 seconds';
    get diagnostics v_missed = row_count;
    update connect_calls set status = 'ended', ended_at = now() where status = 'accepted' and ended_at is null and coalesce(answered_at, created_at) < now() - interval '6 hours';
    get diagnostics v_ended = row_count;
    delete from connect_calls where expires_at <= now();
    get diagnostics v_calls = row_count;
    update connect_meetings set status = 'ended', ended_at = now(), expires_at = now() + interval '24 hours'
    where status = 'live' and created_at < now() - interval '12 hours'
      and not exists (select 1 from connect_meeting_peers p where p.meeting_id = connect_meetings.id and p.left_at is null);
    delete from connect_meetings where status = 'ended' and coalesce(expires_at, ended_at + interval '24 hours') <= now();
    get diagnostics v_meetings = row_count;
    select count(*) into v_trash from connect_storage_trash;
    -- the files themselves go through the Storage API (connect-cleanup), as deleting storage.objects does not
    if v_trash > 0 then
        begin
            if exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key') then
                perform net.http_post(
                    url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/connect-cleanup',
                    headers := jsonb_build_object('Content-Type', 'application/json',
                        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)),
                    body := '{}'::jsonb);
            end if;
        exception when others then
            -- no vault or pg_net here (tests), or the call failed: the files wait for the next run
            null;
        end;
    end if;
    return jsonb_build_object('items', v_items, 'missedCalls', v_missed, 'endedCalls', v_ended, 'calls', v_calls, 'meetings', v_meetings, 'filesQueued', v_trash);
end;
$$;
revoke all on function public.prosm_time_connect_cleanup() from public, anon, authenticated;

-- the files the cleanup function may remove (called by connect-cleanup with the service role)
create or replace function public.prosm_time_connect_take_trash(p_limit integer default 500)
returns setof text
language sql
security definer
set search_path = public
as $$
    select path from connect_storage_trash order by queued_at limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;
create or replace function public.prosm_time_connect_trash_done(p_paths text[])
returns integer
language sql
security definer
set search_path = public
as $$
    with gone as (delete from connect_storage_trash where path = any(p_paths) returning 1) select count(*)::int from gone;
$$;
revoke all on function public.prosm_time_connect_take_trash(integer) from public, anon, authenticated;
revoke all on function public.prosm_time_connect_trash_done(text[]) from public, anon, authenticated;
-- for the connect-cleanup function only (it calls with the service role; nobody signed in can)
grant execute on function public.prosm_time_connect_take_trash(integer) to service_role;
grant execute on function public.prosm_time_connect_trash_done(text[]) to service_role;

do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule('prosm-time-connect-cleanup') where exists (select 1 from cron.job where jobname = 'prosm-time-connect-cleanup');
        perform cron.schedule('prosm-time-connect-cleanup', '7 * * * *', 'select public.prosm_time_connect_cleanup()');
    end if;
end $$;

commit;
