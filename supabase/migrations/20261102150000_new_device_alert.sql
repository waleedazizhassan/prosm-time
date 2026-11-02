-- 2026-11-02 (plan stage 7.4): a sign-in from a device the person never used alerts
-- them and the owner, and goes to the audit log. Signing out and back in on the same
-- device, or reinstalling on the same phone, stays quiet; a person's first device too.
-- Rollback: drop the trigger, its function and the table, restore the type check.

begin;

create table public.known_login_devices (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    device_id text not null,
    platform text,
    label text,
    first_seen_at timestamptz not null default now(),
    unique (user_id, device_id)
);

alter table public.known_login_devices enable row level security;
revoke all on public.known_login_devices from anon, authenticated;

insert into public.known_login_devices (organization_id, user_id, device_id, platform, label, first_seen_at)
select organization_id, user_id, device_id, platform, label, coalesce(last_seen_at, now())
from public.signed_in_devices
on conflict (user_id, device_id) do nothing;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected', 'long_session_check', 'session_auto_closed',
    'exit_site_prompt', 'auto_checkout_geofence', 'clock_in_reminder', 'clock_out_reminder', 'license_ending',
    'new_device_login'
]::text[]));

create or replace function public.prosm_time_alert_new_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_had_devices boolean;
    v_same_phone boolean;
    v_rows integer;
    v_name text;
    v_owner uuid;
    v_label text := coalesce(new.label, new.platform);
begin
    select exists (select 1 from known_login_devices where user_id = new.user_id) into v_had_devices;
    select exists (
        select 1 from known_login_devices
        where user_id = new.user_id and platform = 'android' and new.platform = 'android' and label = new.label
    ) into v_same_phone;

    insert into known_login_devices (organization_id, user_id, device_id, platform, label)
    values (new.organization_id, new.user_id, new.device_id, new.platform, new.label)
    on conflict (user_id, device_id) do nothing;
    get diagnostics v_rows = row_count;

    if v_rows = 0 or not v_had_devices or v_same_phone then return new; end if;

    select full_name into v_name from users where id = new.user_id;
    perform public.create_prosm_time_notification(
        new.organization_id, new.user_id, 'new_device_login', 'high', 'New device signed in',
        'Your account was opened on a new device: ' || v_label || '. If this was not you, change your password.',
        'known_login_devices', null, jsonb_build_object('device', v_label)
    );
    for v_owner in select id from users where organization_id = new.organization_id and is_owner and id <> new.user_id loop
        perform public.create_prosm_time_notification(
            new.organization_id, v_owner, 'new_device_login', 'high', 'New device signed in',
            v_name || ' signed in on a new device: ' || v_label || '.',
            'known_login_devices', null, jsonb_build_object('device', v_label, 'name', v_name)
        );
    end loop;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (new.organization_id, new.user_id, 'security.new_device', 'signed_in_devices', 'Sign-in from a new device', jsonb_build_object('device', v_label, 'platform', new.platform));
    return new;
end;
$$;
revoke all on function public.prosm_time_alert_new_device() from public, anon, authenticated;

create trigger signed_in_devices_new_device_alert
after insert on public.signed_in_devices
for each row execute function public.prosm_time_alert_new_device();

commit;
