-- Owner 2026-10-20: push notifications arrived in English. Each phone now
-- registers the language its app is shown in, and send-push writes every
-- notification from its type and data in that language - the same texts
-- the in-app bell uses (localizeNotification).

begin;

alter table public.push_devices add column language text not null default 'ar'
    check (language in ('ar', 'en', 'de', 'fr', 'it'));

drop function if exists public.register_prosm_time_push_device(text, text);

create or replace function public.register_prosm_time_push_device(p_token text, p_platform text, p_language text default 'ar')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_language text := case when p_language in ('ar', 'en', 'de', 'fr', 'it') then p_language else 'ar' end;
begin
    if v_user is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_token is null or length(trim(p_token)) < 20 or length(p_token) > 4096 then raise exception 'INVALID PUSH TOKEN'; end if;
    if p_platform not in ('android', 'ios', 'web') then raise exception 'INVALID PLATFORM'; end if;

    insert into push_devices (organization_id, user_id, token, platform, language)
    values (v_org, v_user, trim(p_token), p_platform, v_language)
    on conflict (token) do update
    set organization_id = excluded.organization_id, user_id = excluded.user_id, platform = excluded.platform,
        language = excluded.language, last_seen_at = now();

    return jsonb_build_object('success', true);
end;
$function$;

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
        'data', n.data,
        'notificationId', n.id,
        'entityType', n.related_entity_type,
        'entityId', n.related_entity_id,
        'devices', coalesce((select jsonb_agg(jsonb_build_object('token', d.token, 'language', d.language)) from push_devices d where d.user_id = n.user_id), '[]'::jsonb),
        'tokens', coalesce((select jsonb_agg(d.token) from push_devices d where d.user_id = n.user_id), '[]'::jsonb)
    )
    from notifications n
    where n.id = p_notification_id;
$function$;

revoke execute on function public.register_prosm_time_push_device(text, text, text) from public, anon;
grant execute on function public.register_prosm_time_push_device(text, text, text) to authenticated, service_role;
revoke execute on function public.get_prosm_time_push_message(uuid) from public, anon, authenticated;
grant execute on function public.get_prosm_time_push_message(uuid) to service_role;

commit;
