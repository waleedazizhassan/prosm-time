-- v2.3.55 (owner 2026-10-27: "the devices count is every device that
-- actually has an account open on it right now"):
-- each phone or browser carries its own id (kept on the device). It is
-- recorded when someone signs in there and seen again whenever the app
-- opens; signing out removes it, and one not seen for 30 days (an app
-- removed without signing out) stops counting. One device counts once,
-- whoever signs in on it. A device new to the organisation is refused when
-- the licence's devices are all in use - the sign-in is then undone.
-- Sessions could not serve: a phone keeps one per sign-in (one person had
-- four open sessions from the same phone).

begin;

create table if not exists public.signed_in_devices (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    device_id text not null check (length(device_id) between 16 and 128),
    platform text not null default 'web' check (platform in ('android', 'ios', 'web')),
    label text check (length(label) <= 120),
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    unique (user_id, device_id)
);
create index if not exists signed_in_devices_org_seen_idx on public.signed_in_devices (organization_id, last_seen_at);

alter table public.signed_in_devices enable row level security;
revoke all on public.signed_in_devices from anon, authenticated;
grant select on public.signed_in_devices to authenticated;
-- the Owner sees the organisation's devices; everyone sees their own
create policy "devices visible to their user or the owner" on public.signed_in_devices
    for select to authenticated
    using (organization_id = public.current_prosm_time_organization_id()
           and (user_id = public.current_prosm_time_user_id() or public.current_prosm_time_user_is_owner()));

-- a device counts while it was seen in the last 30 days
create or replace function public.prosm_time_active_device_count(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $function$
    select count(distinct device_id)::integer from signed_in_devices
    where organization_id = p_org and last_seen_at > now() - interval '30 days';
$function$;

revoke all on function public.prosm_time_active_device_count(uuid) from public, anon, authenticated;

create or replace function public.register_prosm_time_device(p_device_id text, p_platform text default 'web', p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_max integer;
    v_known boolean;
begin
    if v_user is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_device_id is null or length(p_device_id) not between 16 and 128 then raise exception 'INVALID DEVICE'; end if;

    -- one device at a time per organisation, so two cannot both take the last place
    perform pg_advisory_xact_lock(hashtext('prosm_time_devices_' || v_org::text));
    select exists (
        select 1 from signed_in_devices where organization_id = v_org and device_id = p_device_id and last_seen_at > now() - interval '30 days'
    ) into v_known;
    if not v_known then
        select max_devices into v_max from license_activation_state where organization_id = v_org;
        if v_max is not null and v_max > 0 and public.prosm_time_active_device_count(v_org) >= v_max then
            raise exception 'LICENSED DEVICE LIMIT REACHED';
        end if;
    end if;

    insert into signed_in_devices (organization_id, user_id, device_id, platform, label)
    values (v_org, v_user, p_device_id, case when p_platform in ('android', 'ios', 'web') then p_platform else 'web' end, left(nullif(trim(coalesce(p_label, '')), ''), 120))
    on conflict (user_id, device_id) do update
    set last_seen_at = now(), organization_id = excluded.organization_id, platform = excluded.platform, label = coalesce(excluded.label, signed_in_devices.label);

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.register_prosm_time_device(text, text, text) from public, anon;
grant execute on function public.register_prosm_time_device(text, text, text) to authenticated;

create or replace function public.forget_prosm_time_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    delete from signed_in_devices where user_id = public.current_prosm_time_user_id() and device_id = p_device_id;
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.forget_prosm_time_device(text) from public, anon;
grant execute on function public.forget_prosm_time_device(text) to authenticated;

-- the company card: users and devices in use against the licence (the Owner's)
create or replace function public.get_prosm_time_seat_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN SEE THE LICENCE'; end if;
    return jsonb_build_object(
        'activeUsers', (select count(*) from users where organization_id = v_org and is_active),
        'maxUsers', (select max_users from license_activation_state where organization_id = v_org),
        'activeDevices', public.prosm_time_active_device_count(v_org),
        'maxDevices', (select max_devices from license_activation_state where organization_id = v_org)
    );
end;
$function$;

commit;
