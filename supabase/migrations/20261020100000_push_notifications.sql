-- Owner 2026-10-18/20: notifications must reach people even when the app
-- is closed. Each phone registers its Firebase Cloud Messaging token; every
-- notification the app creates (SOS, reviews, leave, reminders...) is then
-- also sent as a push to that person's phones by the send-push Edge
-- Function, in the background (pg_net), so creating a notification never
-- waits for, or fails because of, the push. Nothing is sent until the
-- service role key is in the vault (as for the scheduled purges) and the
-- function has its FCM_SERVICE_ACCOUNT secret.

begin;

create table public.push_devices (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    token text not null unique,
    platform text not null check (platform in ('android', 'ios', 'web')),
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create index push_devices_user_idx on public.push_devices (user_id);

alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon, authenticated;
grant select on public.push_devices to authenticated;

create policy "members see their own push devices" on public.push_devices
for select to authenticated
using (user_id = public.current_prosm_time_user_id());

-- A phone's token belongs to whoever signed in on it last.
create or replace function public.register_prosm_time_push_device(p_token text, p_platform text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_user is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_token is null or length(trim(p_token)) < 20 or length(p_token) > 4096 then raise exception 'INVALID PUSH TOKEN'; end if;
    if p_platform not in ('android', 'ios', 'web') then raise exception 'INVALID PLATFORM'; end if;

    insert into push_devices (organization_id, user_id, token, platform)
    values (v_org, v_user, trim(p_token), p_platform)
    on conflict (token) do update
    set organization_id = excluded.organization_id, user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();

    return jsonb_build_object('success', true);
end;
$function$;

-- On sign-out the phone stops receiving that person's notifications.
create or replace function public.unregister_prosm_time_push_device(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    delete from push_devices where token = p_token and user_id = public.current_prosm_time_user_id();
    return jsonb_build_object('success', true);
end;
$function$;

-- For send-push (service role only): what to send, and where.
create or replace function public.get_prosm_time_push_message(p_notification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    select jsonb_build_object(
        'title', n.title,
        'body', coalesce(n.body, ''),
        'type', n.type,
        'priority', n.priority,
        'notificationId', n.id,
        'entityType', n.related_entity_type,
        'entityId', n.related_entity_id,
        'tokens', coalesce((select jsonb_agg(d.token) from push_devices d where d.user_id = n.user_id), '[]'::jsonb)
    )
    from notifications n
    where n.id = p_notification_id;
$function$;

-- For send-push (service role only): tokens Firebase says no longer exist.
create or replace function public.forget_prosm_time_push_tokens(p_tokens text[])
returns integer
language sql
security definer
set search_path = public
as $function$
    with gone as (delete from push_devices where token = any(p_tokens) returning 1)
    select count(*)::int from gone;
$function$;

create or replace function public.prosm_time_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if exists (select 1 from push_devices where user_id = new.user_id)
       and exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key') then
        perform net.http_post(
            url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/send-push',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
            ),
            body := jsonb_build_object('notificationId', new.id)
        );
    end if;
    return new;
exception
    when others then
        -- A push is a best-effort extra; the notification itself always stays.
        return new;
end;
$function$;

create trigger notifications_send_push
after insert on public.notifications
for each row execute function public.prosm_time_push_notification();

revoke execute on function public.register_prosm_time_push_device(text, text) from public, anon;
revoke execute on function public.unregister_prosm_time_push_device(text) from public, anon;
grant execute on function public.register_prosm_time_push_device(text, text) to authenticated, service_role;
grant execute on function public.unregister_prosm_time_push_device(text) to authenticated, service_role;
revoke execute on function public.get_prosm_time_push_message(uuid) from public, anon, authenticated;
revoke execute on function public.forget_prosm_time_push_tokens(text[]) from public, anon, authenticated;
grant execute on function public.get_prosm_time_push_message(uuid) to service_role;
grant execute on function public.forget_prosm_time_push_tokens(text[]) to service_role;
revoke execute on function public.prosm_time_push_notification() from public, anon, authenticated;

commit;
