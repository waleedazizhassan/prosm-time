-- PROSM Connect - stages 2 to 7 on the server (owner 2026-11-13: "finish it all and test everything"). The switchboard
-- carries the requests; these functions keep the state of calls and meetings, seal verified photos, and tell a
-- sender that their message arrived or was read - over the sender's own private channel, without storing anything.
--   Calls: start (busy when the other is already in a call), answer (accept / reject / busy), end (ended, failed,
--   missed, cancelled); a person's call log (24 hours on the server, kept on the phone after that).
--   Meetings: start with invitations (4 with video, 8 with sound only - every plan), leave, end (host), recording
--   allowed or not (host), the meetings one is in.
--   Verified photo: the server's time, the nearest of the organisation's sites and whether the phone is inside it,
--   and a short code; then the photo's SHA-256 once stamped. Anyone in the organisation can check a code.
--   Receipts: "arrived" when the recipient acknowledges, "read" when they open it - sent to the sender live.
--   Push: a new request asks connect-send-push to wake the recipients' phones (calls ring, messages notify).
-- Rollback: drop the functions created here; drop trigger connect_switchboard_push; restore prosm_time_connect_ack
-- from 20261114100000.

begin;

-- live notice to a person's own channel (nothing stored; skipped where Realtime does not exist)
create or replace function public.prosm_time_connect_notify(p_user uuid, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then return; end if;
    perform realtime.send(p_payload, p_event, 'connect:user:' || p_user::text, true);
exception when others then
    null;
end;
$$;
revoke all on function public.prosm_time_connect_notify(uuid, text, jsonb) from public, anon, authenticated;

-- "received": as before, and the sender hears it at once (✓✓)
create or replace function public.prosm_time_connect_ack(p_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_item connect_switchboard%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_item from connect_switchboard where id = p_item_id;
    update connect_receipts set delivered_at = coalesce(delivered_at, now())
    where item_id = p_item_id and recipient_id = v_me;
    if not found then return false; end if;
    perform public.prosm_time_connect_notify(v_item.from_user, 'receipt',
        jsonb_build_object('itemId', v_item.id, 'clientId', v_item.client_id, 'by', v_me, 'state', 'delivered'));
    if not exists (select 1 from connect_receipts where item_id = p_item_id and delivered_at is null) then
        delete from connect_switchboard where id = p_item_id;
        if v_item.attachment_path is not null then insert into connect_storage_trash (path) values (v_item.attachment_path) on conflict do nothing; end if;
    end if;
    return true;
end;
$$;

-- "read": the recipient opened these messages; their senders hear it (the messages may be gone from the server)
create or replace function public.prosm_time_connect_mark_read(p_sender uuid, p_client_ids text[])
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from users where id = p_sender and organization_id = public.current_prosm_time_organization_id()) then return false; end if;
    if not public.prosm_time_connect_enabled(public.current_prosm_time_organization_id()) then return false; end if;
    perform public.prosm_time_connect_notify(p_sender, 'receipt',
        jsonb_build_object('clientIds', to_jsonb(coalesce(p_client_ids[1:200], array[]::text[])), 'by', v_me, 'state', 'read'));
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_mark_read(uuid, text[]) from public, anon;
grant execute on function public.prosm_time_connect_mark_read(uuid, text[]) to authenticated;

-- 1. Calls ----------------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_connect_in_call(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from connect_calls c
                   where p_user in (c.caller_id, c.callee_id)
                     and (c.status = 'accepted' or (c.status = 'ringing' and c.created_at > now() - interval '45 seconds')));
$$;
revoke all on function public.prosm_time_connect_in_call(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_connect_start_call(p_callee uuid, p_media text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_call uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_media not in ('audio', 'video') then raise exception 'INVALID MEDIA'; end if;
    if not public.prosm_time_connect_feature(v_org, 'connect_calls') then raise exception 'FEATURE NOT IN PLAN: connect_calls'; end if;
    if p_callee = v_me or not exists (select 1 from users where id = p_callee and organization_id = v_org and is_active) then
        raise exception 'USER NOT FOUND';
    end if;
    if public.prosm_time_connect_in_call(v_me) then
        -- a call of mine left behind (an app closed mid-call) ends now
        update connect_calls set status = 'ended', ended_at = now()
        where v_me in (caller_id, callee_id) and status in ('ringing', 'accepted');
    end if;
    if public.prosm_time_connect_in_call(p_callee) then
        insert into connect_calls (organization_id, caller_id, callee_id, media, status, ended_at)
        values (v_org, v_me, p_callee, p_media, 'busy', now()) returning id into v_call;
        return jsonb_build_object('callId', v_call, 'status', 'busy');
    end if;
    insert into connect_calls (organization_id, caller_id, callee_id, media) values (v_org, v_me, p_callee, p_media) returning id into v_call;
    insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id, expires_at)
    values (v_org, v_me, p_callee, case p_media when 'video' then 'video_call' else 'audio_call' end, v_call, now() + interval '2 minutes');
    return jsonb_build_object('callId', v_call, 'status', 'ringing');
end;
$$;
revoke all on function public.prosm_time_connect_start_call(uuid, text) from public, anon;
grant execute on function public.prosm_time_connect_start_call(uuid, text) to authenticated;

create or replace function public.prosm_time_connect_answer_call(p_call uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_call connect_calls%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_call from connect_calls where id = p_call for update;
    if v_call.id is null or v_call.callee_id <> v_me then raise exception 'CALL NOT FOUND'; end if;
    if p_action not in ('accept', 'reject', 'busy') then raise exception 'INVALID ACTION'; end if;
    if v_call.status <> 'ringing' then return jsonb_build_object('status', v_call.status); end if;
    if p_action = 'accept' then
        update connect_calls set status = 'accepted', answered_at = now() where id = p_call;
    else
        update connect_calls set status = case p_action when 'reject' then 'rejected' else 'busy' end, ended_at = now() where id = p_call;
    end if;
    perform public.prosm_time_connect_notify(v_call.caller_id, 'call', jsonb_build_object('callId', p_call, 'state', p_action));
    -- the person's other phones stop ringing
    perform public.prosm_time_connect_notify(v_me, 'call', jsonb_build_object('callId', p_call, 'state', 'answered-elsewhere'));
    delete from connect_switchboard where ref_id = p_call and type in ('audio_call', 'video_call');
    return jsonb_build_object('status', case p_action when 'accept' then 'accepted' when 'reject' then 'rejected' else 'busy' end);
end;
$$;
revoke all on function public.prosm_time_connect_answer_call(uuid, text) from public, anon;
grant execute on function public.prosm_time_connect_answer_call(uuid, text) to authenticated;

create or replace function public.prosm_time_connect_end_call(p_call uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_call connect_calls%rowtype;
    v_status text;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_call from connect_calls where id = p_call for update;
    if v_call.id is null or v_me not in (v_call.caller_id, v_call.callee_id) then raise exception 'CALL NOT FOUND'; end if;
    if v_call.status not in ('ringing', 'accepted') then return jsonb_build_object('status', v_call.status); end if;
    v_status := case
        when p_reason = 'failed' then 'failed'
        when v_call.status = 'ringing' and p_reason in ('missed', 'cancelled') then 'missed'
        else 'ended' end;
    update connect_calls set status = v_status, ended_at = now() where id = p_call;
    delete from connect_switchboard where ref_id = p_call and type in ('audio_call', 'video_call');
    perform public.prosm_time_connect_notify(case when v_me = v_call.caller_id then v_call.callee_id else v_call.caller_id end,
        'call', jsonb_build_object('callId', p_call, 'state', 'ended', 'status', v_status));
    if v_status = 'missed' then
        insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id)
        values (v_call.organization_id, v_call.caller_id, v_call.callee_id, 'missed', p_call);
    end if;
    return jsonb_build_object('status', v_status);
end;
$$;
revoke all on function public.prosm_time_connect_end_call(uuid, text) from public, anon;
grant execute on function public.prosm_time_connect_end_call(uuid, text) to authenticated;

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
      and c.organization_id = public.current_prosm_time_organization_id();
$$;
revoke all on function public.list_prosm_time_connect_calls() from public, anon;
grant execute on function public.list_prosm_time_connect_calls() to authenticated;

-- 2. Meetings -------------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_connect_start_meeting(p_media text, p_invitees uuid[], p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_meeting uuid;
    v_max integer := case p_media when 'video' then 4 else 8 end;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_media not in ('audio', 'video') then raise exception 'INVALID MEDIA'; end if;
    if not public.prosm_time_connect_feature(v_org, 'connect_meetings') then raise exception 'FEATURE NOT IN PLAN: connect_meetings'; end if;
    if coalesce(array_length(p_invitees, 1), 0) = 0 then raise exception 'INVITE SOMEONE'; end if;
    if array_length(p_invitees, 1) > v_max - 1 then raise exception 'THIS MEETING IS FULL'; end if;
    if exists (select 1 from unnest(p_invitees) i where not exists (select 1 from users u where u.id = i and u.organization_id = v_org and u.is_active)) then
        raise exception 'USER NOT FOUND';
    end if;
    insert into connect_meetings (organization_id, host_id, media, max_peers) values (v_org, v_me, p_media, v_max) returning id into v_meeting;
    insert into connect_meeting_peers (meeting_id, user_id) values (v_meeting, v_me);
    insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id, body, expires_at)
    select v_org, v_me, i, 'meeting_invite', v_meeting, left(nullif(trim(coalesce(p_title, '')), ''), 120) || '|' || p_media, now() + interval '2 hours'
    from (select distinct i from unnest(p_invitees) i where i <> v_me) x;
    return v_meeting;
end;
$$;
revoke all on function public.prosm_time_connect_start_meeting(text, uuid[], text) from public, anon;
grant execute on function public.prosm_time_connect_start_meeting(text, uuid[], text) to authenticated;

create or replace function public.prosm_time_connect_leave_meeting(p_meeting uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    update connect_meeting_peers set left_at = now() where meeting_id = p_meeting and user_id = v_me and left_at is null;
    -- the last one out ends it
    if not exists (select 1 from connect_meeting_peers where meeting_id = p_meeting and left_at is null) then
        update connect_meetings set status = 'ended', ended_at = now(), expires_at = now() + interval '24 hours' where id = p_meeting and status = 'live';
    end if;
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_leave_meeting(uuid) from public, anon;
grant execute on function public.prosm_time_connect_leave_meeting(uuid) to authenticated;

create or replace function public.prosm_time_connect_end_meeting(p_meeting uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    update connect_meetings set status = 'ended', ended_at = now(), expires_at = now() + interval '24 hours'
    where id = p_meeting and host_id = public.current_prosm_time_user_id() and status = 'live';
    if not found then raise exception 'ONLY THE HOST ENDS THE MEETING'; end if;
    update connect_meeting_peers set left_at = coalesce(left_at, now()) where meeting_id = p_meeting;
    delete from connect_switchboard where ref_id = p_meeting and type = 'meeting_invite';
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_end_meeting(uuid) from public, anon;
grant execute on function public.prosm_time_connect_end_meeting(uuid) to authenticated;

create or replace function public.prosm_time_connect_set_recording(p_meeting uuid, p_allowed boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    update connect_meetings set recording_allowed = p_allowed
    where id = p_meeting and host_id = public.current_prosm_time_user_id() and status = 'live';
    if not found then raise exception 'ONLY THE HOST DECIDES'; end if;
    return true;
end;
$$;
revoke all on function public.prosm_time_connect_set_recording(uuid, boolean) from public, anon;
grant execute on function public.prosm_time_connect_set_recording(uuid, boolean) to authenticated;

create or replace function public.get_prosm_time_connect_meeting(p_meeting uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object('id', m.id, 'hostId', m.host_id, 'media', m.media, 'maxPeers', m.max_peers, 'status', m.status,
               'recordingAllowed', m.recording_allowed, 'createdAt', m.created_at,
               'recordingFeature', public.prosm_time_connect_feature(m.organization_id, 'connect_meeting_recording'),
               'screenShareFeature', public.prosm_time_connect_feature(m.organization_id, 'connect_screen_share'),
               'peers', coalesce((select jsonb_agg(p.user_id) from connect_meeting_peers p where p.meeting_id = m.id and p.left_at is null), '[]'::jsonb))
    from connect_meetings m
    where m.id = p_meeting and m.organization_id = public.current_prosm_time_organization_id()
      and (m.host_id = public.current_prosm_time_user_id()
           or exists (select 1 from connect_switchboard s join connect_receipts r on r.item_id = s.id
                      where s.ref_id = m.id and s.type = 'meeting_invite' and r.recipient_id = public.current_prosm_time_user_id())
           or exists (select 1 from connect_meeting_peers p where p.meeting_id = m.id and p.user_id = public.current_prosm_time_user_id()));
$$;
revoke all on function public.get_prosm_time_connect_meeting(uuid) from public, anon;
grant execute on function public.get_prosm_time_connect_meeting(uuid) to authenticated;

-- an invitee may join: the join function checks the meeting is theirs to join (invited or host)
do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_connect_join_meeting(uuid)'::regprocedure);
    v_old text := '    if v_meeting.status <> ''live'' then raise exception ''THIS MEETING HAS ENDED''; end if;';
begin
    if position(v_old in v_def) = 0 then raise exception 'join meeting: anchor not found'; end if;
    execute replace(v_def, v_old, v_old || '
    if v_meeting.host_id <> v_me
       and not exists (select 1 from connect_meeting_peers where meeting_id = p_meeting_id and user_id = v_me)
       and not exists (select 1 from connect_switchboard s join connect_receipts r on r.item_id = s.id
                       where s.ref_id = p_meeting_id and s.type = ''meeting_invite'' and r.recipient_id = v_me)
       and not exists (select 1 from connect_switchboard s where s.ref_id = p_meeting_id and s.type = ''meeting_invite'' and s.to_user = v_me) then
        raise exception ''YOU ARE NOT INVITED'';
    end if;');
end $$;

-- 3. Verified photo -------------------------------------------------------------------------------------------------
create or replace function public.prosm_time_connect_photo_proof(p_lat double precision, p_lng double precision, p_accuracy real)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_site record;
    v_code text;
    v_inside boolean := false;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_connect_feature(v_org, 'connect_camera_photo') then raise exception 'FEATURE NOT IN PLAN: connect_camera_photo'; end if;
    if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'LATITUDE AND LONGITUDE ARE REQUIRED'; end if;
    select s.id, s.name, s.allowed_radius_meters, s.gps_accuracy_tolerance_meters,
           6371000 * 2 * asin(sqrt(power(sin(radians(p_lat - s.latitude) / 2), 2)
               + cos(radians(s.latitude)) * cos(radians(p_lat)) * power(sin(radians(p_lng - s.longitude) / 2), 2))) as d
      into v_site
      from sites s where s.organization_id = v_org and s.latitude is not null and s.longitude is not null
      order by d limit 1;
    if v_site.id is not null then
        v_inside := v_site.d <= v_site.allowed_radius_meters + coalesce(v_site.gps_accuracy_tolerance_meters, 0) + least(coalesce(p_accuracy, 0), 50);
    end if;
    loop
        v_code := 'PT-' || upper(substr(md5(gen_random_uuid()::text), 1, 4)) || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 2));
        exit when not exists (select 1 from connect_photo_proofs where code = v_code);
    end loop;
    insert into connect_photo_proofs (organization_id, user_id, code, site_id, inside_site, lat, lng, accuracy_m)
    values (v_org, v_me, v_code, case when v_site.d <= 5000 then v_site.id end, v_inside, p_lat, p_lng, p_accuracy);
    return jsonb_build_object('code', v_code, 'serverTime', now(),
        'siteName', case when v_site.d <= 5000 then v_site.name end, 'inside', v_inside,
        'name', (select full_name from users where id = v_me),
        'ext', (select ext from connect_extensions where user_id = v_me));
end;
$$;
revoke all on function public.prosm_time_connect_photo_proof(double precision, double precision, real) from public, anon;
grant execute on function public.prosm_time_connect_photo_proof(double precision, double precision, real) to authenticated;

create or replace function public.prosm_time_connect_photo_sealed(p_code text, p_sha256 text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'INVALID FINGERPRINT'; end if;
    update connect_photo_proofs set image_sha256 = p_sha256
    where code = p_code and user_id = public.current_prosm_time_user_id() and image_sha256 is null
      and created_at > now() - interval '30 minutes';
    return found;
end;
$$;
revoke all on function public.prosm_time_connect_photo_sealed(text, text) from public, anon;
grant execute on function public.prosm_time_connect_photo_sealed(text, text) to authenticated;

create or replace function public.prosm_time_connect_verify_photo(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object('code', p.code, 'serverTime', p.server_time, 'inside', p.inside_site, 'sha256', p.image_sha256,
               'siteName', (select s.name from sites s where s.id = p.site_id), 'name', u.full_name,
               'lat', p.lat, 'lng', p.lng, 'accuracy', p.accuracy_m)
    from connect_photo_proofs p join users u on u.id = p.user_id
    where p.code = upper(trim(p_code)) and p.organization_id = public.current_prosm_time_organization_id();
$$;
revoke all on function public.prosm_time_connect_verify_photo(text) from public, anon;
grant execute on function public.prosm_time_connect_verify_photo(text) to authenticated;

-- 4. Push: wake the recipients' phones -------------------------------------------------------------------------------
create or replace function public.get_prosm_time_connect_push(p_item uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'id', s.id, 'type', s.type, 'body', left(s.body, 160), 'refId', s.ref_id, 'conversationId', s.conversation_id,
        'fromName', (select full_name from users where id = s.from_user), 'fromId', s.from_user,
        'devices', coalesce((select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform, 'userId', d.user_id,
                                 'language', coalesce(nullif(d.language, ''), 'ar')))
                             from push_devices d join connect_receipts r on r.recipient_id = d.user_id
                             where r.item_id = s.id and r.delivered_at is null), '[]'::jsonb))
    from connect_switchboard s where s.id = p_item;
$$;
revoke all on function public.get_prosm_time_connect_push(uuid) from public, anon, authenticated;
grant execute on function public.get_prosm_time_connect_push(uuid) to service_role;

create or replace function public.prosm_time_connect_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.type in ('accept', 'reject', 'busy', 'end') then return new; end if;
    if exists (select 1 from connect_receipts r join push_devices d on d.user_id = r.recipient_id where r.item_id = new.id) then
        begin
            if exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key') then
                perform net.http_post(
                    url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/connect-send-push',
                    headers := jsonb_build_object('Content-Type', 'application/json',
                        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)),
                    body := jsonb_build_object('itemId', new.id));
            end if;
        exception when others then
            null; -- a push is an extra; the request waits in the inbox anyway
        end;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_connect_push() from public, anon, authenticated;
drop trigger if exists connect_switchboard_push on public.connect_switchboard;
create trigger connect_switchboard_push after insert on public.connect_switchboard
    for each row execute function public.prosm_time_connect_push();

commit;
