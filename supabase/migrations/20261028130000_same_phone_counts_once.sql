-- v2.3.59 (owner 2026-10-28, signed out on his own phone): the app keeps its
-- device id in its own storage, so clearing the app's data or reinstalling it
-- gave the same phone a new id - and every time it took another of the
-- licence's devices, until the phone was refused ("LICENSED DEVICE LIMIT
-- REACHED") and signed out. Now, when a person signs in on an Android phone
-- that is new to the organisation, their earlier id for a phone of the same
-- model (the label, "Android - <model>") is that phone before its data was
-- cleared: it is replaced, not added. Only Android, only the same person and
-- the same model; the web and other phones count as before.

begin;

create or replace function public.register_prosm_time_device(p_device_id text, p_platform text default 'web'::text, p_label text default null::text)
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

    insert into signed_in_devices (organization_id, user_id, device_id, platform, label)
    values (v_org, v_user, p_device_id, case when p_platform in ('android', 'ios', 'web') then p_platform else 'web' end, v_label)
    on conflict (user_id, device_id) do update
    set last_seen_at = now(), organization_id = excluded.organization_id, platform = excluded.platform, label = coalesce(excluded.label, signed_in_devices.label);

    return jsonb_build_object('success', true);
end;
$function$;

commit;
