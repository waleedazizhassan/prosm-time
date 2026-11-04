-- Owner 2026-11-04: in People, next to each person, whether they accepted the invitation, and
-- the app version they use. Each device reports its version when it registers.

alter table public.signed_in_devices add column if not exists app_version text;

drop function if exists public.register_prosm_time_device(text, text, text);

create or replace function public.register_prosm_time_device(p_device_id text, p_platform text default 'web', p_label text default null, p_app_version text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_user uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_max integer;
    v_known boolean;
    v_label text := left(nullif(trim(coalesce(p_label, '')), ''), 120);
    v_version text := left(nullif(regexp_replace(coalesce(p_app_version, ''), '[^0-9A-Za-z.+-]', '', 'g'), ''), 32);
begin
    if v_user is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_device_id is null or length(p_device_id) not between 16 and 128 then raise exception 'INVALID DEVICE'; end if;

    -- one device at a time per organisation, so two cannot both take the last place
    perform pg_advisory_xact_lock(hashtext('prosm_time_devices_' || v_org::text));
    select exists (
        select 1 from signed_in_devices where organization_id = v_org and device_id = p_device_id and last_seen_at > now() - interval '30 days'
    ) into v_known;
    if not v_known then
        -- the same phone after its app data was cleared or the app reinstalled
        if p_platform = 'android' and v_label is not null then
            delete from signed_in_devices
            where organization_id = v_org
              and device_id in (
                  select device_id from signed_in_devices
                  where organization_id = v_org and user_id = v_user and platform = 'android' and label = v_label and device_id <> p_device_id
              );
        end if;
        select max_devices into v_max from license_activation_state where organization_id = v_org;
        if v_max is not null and v_max > 0 and public.prosm_time_active_device_count(v_org) >= v_max then
            raise exception 'LICENSED DEVICE LIMIT REACHED';
        end if;
    end if;

    insert into signed_in_devices (organization_id, user_id, device_id, platform, label, app_version)
    values (v_org, v_user, p_device_id, case when p_platform in ('android', 'ios', 'web') then p_platform else 'web' end, v_label, v_version)
    on conflict (user_id, device_id) do update
    set last_seen_at = now(), organization_id = excluded.organization_id, platform = excluded.platform,
        label = coalesce(excluded.label, signed_in_devices.label),
        app_version = coalesce(excluded.app_version, signed_in_devices.app_version);

    return jsonb_build_object('success', true);
end;
$function$;
revoke all on function public.register_prosm_time_device(text, text, text, text) from public, anon;
grant execute on function public.register_prosm_time_device(text, text, text, text) to authenticated;

-- Per person of the caller's organisation: the invitation's state (accepted, waiting, expired),
-- the app version of their most recently used device, and when it was last used. For the
-- Owner and anyone who manages people.
create or replace function public.list_prosm_time_people_status()
returns table (user_id uuid, invitation text, app_version text, platform text, last_seen_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (
        select 1 from users u left join roles r on r.id = u.role_id
        where u.id = v_caller and (u.is_owner or r.role_key in ('manager', 'supervisor'))
    ) then
        return;
    end if;
    return query
    select u.id,
           case
               when u.is_owner then 'accepted'
               when exists (select 1 from user_invitations i where i.user_id = u.id and i.consumed_at is not null) then 'accepted'
               when exists (select 1 from signed_in_devices d where d.user_id = u.id) then 'accepted'
               when not exists (select 1 from user_invitations i where i.user_id = u.id) then 'accepted'
               when exists (select 1 from user_invitations i where i.user_id = u.id and i.status = 'pending' and i.expires_at > now()) then 'pending'
               else 'expired'
           end,
           d.app_version, d.platform, d.last_seen_at
    from users u
    left join lateral (
        select x.app_version, x.platform, x.last_seen_at from signed_in_devices x
        where x.user_id = u.id order by x.last_seen_at desc limit 1
    ) d on true
    where u.organization_id = v_org;
end;
$function$;
revoke all on function public.list_prosm_time_people_status() from public, anon;
grant execute on function public.list_prosm_time_people_status() to authenticated;
