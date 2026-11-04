-- 2026-11-03 (owner): "a licence and a number of devices - the change must be real for
-- anything that happens on the platform, and the owner must be told what changed."
-- 1. Every 10 minutes the server mirrors each organisation's licence from PROSM Platform
--    (sync-all-licenses), so the limits enforced here (users trigger, device sign-in)
--    follow Platform Manager without anyone opening the app.
-- 2. When the licence actually changes - users, devices, end date, status or plan - each
--    owner gets a notification (and a push) saying what changed, and it is audited.
-- Rollback: unschedule 'prosm-time-license-sync', drop the trigger and its function, drop
-- list_prosm_time_licences_for_sync, restore the type check without 'license_changed'.

begin;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected', 'long_session_check', 'session_auto_closed',
    'exit_site_prompt', 'auto_checkout_geofence', 'clock_in_reminder', 'clock_out_reminder', 'license_ending',
    'new_device_login', 'shift_no_show', 'overtime_soon', 'daily_digest', 'license_changed'
]::text[]));

create or replace function public.list_prosm_time_licences_for_sync()
returns table (organization_id uuid, license_number text)
language sql
stable
security definer
set search_path = public
as $$
    select l.organization_id, l.license_number
    from license_activation_state l
    join organizations o on o.id = l.organization_id
    where l.license_number is not null;
$$;
revoke all on function public.list_prosm_time_licences_for_sync() from public, anon, authenticated;
grant execute on function public.list_prosm_time_licences_for_sync() to service_role;

create or replace function public.prosm_time_notify_license_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner uuid;
    v_data jsonb;
    v_parts text[] := '{}';
    v_users_changed boolean := new.max_users is distinct from old.max_users;
    v_devices_changed boolean := new.max_devices is distinct from old.max_devices;
    v_expiry_changed boolean := new.expires_at::date is distinct from old.expires_at::date;
    v_status_changed boolean := new.status is distinct from old.status;
    v_plan_changed boolean := new.plan_id is distinct from old.plan_id;
begin
    if not (v_users_changed or v_devices_changed or v_expiry_changed or v_status_changed or v_plan_changed) then
        return new;
    end if;

    v_data := jsonb_build_object('licenseNumber', new.license_number);
    if v_users_changed then
        v_data := v_data || jsonb_build_object('usersFrom', old.max_users, 'usersTo', new.max_users, 'usersChanged', true);
        v_parts := v_parts || ('users ' || coalesce(old.max_users::text, 'unlimited') || ' -> ' || coalesce(new.max_users::text, 'unlimited'));
    end if;
    if v_devices_changed then
        v_data := v_data || jsonb_build_object('devicesFrom', old.max_devices, 'devicesTo', new.max_devices, 'devicesChanged', true);
        v_parts := v_parts || ('devices ' || coalesce(old.max_devices::text, 'unlimited') || ' -> ' || coalesce(new.max_devices::text, 'unlimited'));
    end if;
    if v_expiry_changed then
        v_data := v_data || jsonb_build_object('expiresAt', new.expires_at, 'expiryChanged', true);
        v_parts := v_parts || ('ends ' || coalesce(to_char(new.expires_at, 'YYYY-MM-DD'), 'never'));
    end if;
    if v_status_changed then
        v_data := v_data || jsonb_build_object('status', new.status, 'statusChanged', true);
        v_parts := v_parts || ('status ' || new.status);
    end if;
    if v_plan_changed then
        v_data := v_data || jsonb_build_object('planChanged', true);
        v_parts := v_parts || 'plan changed'::text;
    end if;

    for v_owner in select id from users where organization_id = new.organization_id and is_owner and is_active loop
        perform public.create_prosm_time_notification(
            new.organization_id, v_owner, 'license_changed', 'high', 'Your licence was changed',
            'PROSM changed your licence: ' || array_to_string(v_parts, ', ') || '.',
            'license_activation_state', new.id, v_data
        );
    end loop;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, previous_state, new_state)
    values (new.organization_id, null, 'license.changed', 'license_activation_state', 'Licence changed in PROSM Platform',
        jsonb_build_object('maxUsers', old.max_users, 'maxDevices', old.max_devices, 'expiresAt', old.expires_at, 'status', old.status, 'planId', old.plan_id),
        jsonb_build_object('maxUsers', new.max_users, 'maxDevices', new.max_devices, 'expiresAt', new.expires_at, 'status', new.status, 'planId', new.plan_id));
    return new;
end;
$$;
revoke all on function public.prosm_time_notify_license_change() from public, anon, authenticated;

drop trigger if exists license_change_notifies_owner on public.license_activation_state;
create trigger license_change_notifies_owner
after update on public.license_activation_state
for each row execute function public.prosm_time_notify_license_change();

-- every 10 minutes; skipped quietly while the vault key is missing
select cron.unschedule('prosm-time-license-sync') where exists (select 1 from cron.job where jobname = 'prosm-time-license-sync');
select cron.schedule('prosm-time-license-sync', '*/10 * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/sync-all-licenses',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
        ),
        body := '{}'::jsonb
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key');
$cron$);

commit;
