-- Demo (owner 2026-09-29): an open 30-day trial started from the Welcome page through the
-- existing activation (only the activation code is skipped). The trial is a real license
-- issued by PROSM Platform (so it shows in Platform Manager), marked here as a trial.
-- When it ends, the organisation's operational data is locked - never deleted - until the
-- license is renewed in Platform Manager or the owner enters a purchased activation code;
-- then the organisation continues with all its data. A week before the end, and when it
-- ends, the owner is notified in the app and by email (sent by send-trial-notices through
-- PROSM Platform's email relay). Normal (non-trial) licenses are not affected.

alter table public.license_activation_state add column if not exists is_trial boolean not null default false;
alter table public.license_activation_state add column if not exists trial_reminder_sent_at timestamptz;
alter table public.license_activation_state add column if not exists trial_ended_notice_sent_at timestamptz;

create or replace function public.prosm_time_org_locked(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    select exists (
        select 1 from license_activation_state l
        where l.organization_id = p_org and l.is_trial and l.expires_at is not null and l.expires_at <= now());
$$;
revoke execute on function public.prosm_time_org_locked(uuid) from public, anon, authenticated;

-- The identity functions every row policy and server function relies on (their existing
-- conditions unchanged): a member of a locked trial organisation is not recognised until renewal.
create or replace function public.current_prosm_time_organization_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
    select u.organization_id from public.users u
    where u.auth_user_id = auth.uid() and not public.prosm_time_org_locked(u.organization_id);
$$;

create or replace function public.current_prosm_time_user_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
    select u.id from public.users u
    where u.auth_user_id = auth.uid() and u.is_active = true and not public.prosm_time_org_locked(u.organization_id);
$$;

create or replace function public.get_prosm_time_trial_status()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
    select coalesce((
        select jsonb_build_object(
            'isTrial', l.is_trial,
            'locked', l.is_trial and l.expires_at is not null and l.expires_at <= now(),
            'expiresAt', l.expires_at,
            'daysLeft', case when l.expires_at is null then null else greatest(0, ceil(extract(epoch from (l.expires_at - now())) / 86400)::int) end,
            'licenseNumber', l.license_number,
            'isOwner', u.is_owner,
            'organizationName', o.name,
            'serverTime', now())
        from users u
        join license_activation_state l on l.organization_id = u.organization_id
        join organizations o on o.id = u.organization_id
        where u.auth_user_id = auth.uid() and u.is_active = true
        limit 1), jsonb_build_object('isTrial', false, 'locked', false));
$$;
revoke execute on function public.get_prosm_time_trial_status() from public, anon;
grant execute on function public.get_prosm_time_trial_status() to authenticated;

create or replace function public.mark_prosm_time_trial(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    update license_activation_state set is_trial = true, updated_at = now() where organization_id = p_organization_id;
    if not found then raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION'; end if;
end;
$$;
revoke execute on function public.mark_prosm_time_trial(uuid) from public, anon, authenticated;

create or replace function public.apply_prosm_time_license(p_organization_id uuid, p_license_number text, p_plan_id uuid, p_max_users integer, p_max_devices integer, p_expires_at timestamptz, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_old text;
begin
    select license_number into v_old from license_activation_state where organization_id = p_organization_id for update;
    if not found then raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION'; end if;
    update license_activation_state
       set license_number = p_license_number, plan_id = p_plan_id, max_users = coalesce(p_max_users, max_users), max_devices = coalesce(p_max_devices, max_devices),
           expires_at = p_expires_at, status = 'ACTIVE', is_trial = false, trial_reminder_sent_at = null, trial_ended_notice_sent_at = null,
           activated_at = now(), last_verified_at = now(), updated_at = now()
     where organization_id = p_organization_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (p_organization_id, p_actor_user_id, 'LICENSE_ACTIVATED', 'license_activation_state', p_organization_id,
            'License ' || p_license_number || ' activated (was ' || coalesce(v_old, '-') || ')');
    return jsonb_build_object('success', true, 'licenseNumber', p_license_number, 'expiresAt', p_expires_at);
end;
$$;
revoke execute on function public.apply_prosm_time_license(uuid, text, uuid, integer, integer, timestamptz, uuid) from public, anon, authenticated;

create or replace function public.refresh_prosm_time_license_state(p_organization_id uuid, p_status text, p_max_users integer, p_max_devices integer, p_expires_at timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
    if p_status not in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED') then
        raise exception 'INVALID LICENSE STATUS';
    end if;

    update license_activation_state
    set
        status = p_status,
        max_users = coalesce(p_max_users, max_users),
        max_devices = coalesce(p_max_devices, max_devices),
        -- A renewal in Platform Manager extends the trial: its notices start again for the new end date.
        trial_reminder_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() + interval '7 days' then null else trial_reminder_sent_at end,
        trial_ended_notice_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() then null else trial_ended_notice_sent_at end,
        expires_at = p_expires_at,
        last_verified_at = now(),
        updated_at = now()
    where organization_id = p_organization_id;

    if not found then
        raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION';
    end if;

    return jsonb_build_object('success', true, 'organizationId', p_organization_id, 'status', p_status);
exception
    when others then
        raise exception 'REFRESH PROSM TIME LICENSE STATE FAILED: %', sqlerrm;
end;
$function$;

-- Due trial notices (a week before the end, and when it ends): each is claimed once, shown in
-- the owner's notifications, and returned for send-trial-notices to email.
create or replace function public.claim_prosm_time_trial_notices()
returns table (kind text, organization_id uuid, organization_name text, owner_email text, license_number text, expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    r record;
    v_contacts constant text := E'\nsales@prosm.net · info@prosm.net · support@prosm.net';
begin
    for r in
        select l.organization_id, l.license_number, l.expires_at, o.name as org_name, u.id as owner_id, u.email as owner_email,
               case when l.expires_at <= now() then 'ENDED' else 'ENDING' end as k
        from license_activation_state l
        join organizations o on o.id = l.organization_id
        join users u on u.organization_id = l.organization_id and u.is_owner and u.is_active
        where l.is_trial and l.expires_at is not null
          and ((l.expires_at > now() and l.expires_at <= now() + interval '7 days' and l.trial_reminder_sent_at is null)
            or (l.expires_at <= now() and l.trial_ended_notice_sent_at is null))
        for update of l skip locked
    loop
        if r.k = 'ENDING' then
            insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
            values (r.organization_id, r.owner_id, 'TRIAL_ENDING', 'high',
                'تنتهي الفترة التجريبية لـ PROSM Time في ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || ' | Your PROSM Time trial ends on ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD'),
                'تنتهي الفترة التجريبية لمؤسسة ' || r.org_name || ' بعد أسبوع. بياناتك محفوظة ولن تُحذف. للاستمرار اشترِ كود تفعيل وأدخله في البرنامج، أو تواصل معنا لتجديد الترخيص (رقم الترخيص ' || r.license_number || '):' || v_contacts ||
                E'\n\nThe trial of ' || r.org_name || ' ends in a week. Your data is kept and will not be deleted. To continue, buy an activation code and enter it in the app, or contact us to renew the license (license ' || r.license_number || '):' || v_contacts,
                'LICENSE', r.organization_id, jsonb_build_object('licenseNumber', r.license_number, 'expiresAt', r.expires_at));
            update license_activation_state set trial_reminder_sent_at = now() where license_activation_state.organization_id = r.organization_id;
        else
            insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
            values (r.organization_id, r.owner_id, 'TRIAL_ENDED', 'high',
                'انتهت الفترة التجريبية لـ PROSM Time | Your PROSM Time trial has ended',
                'انتهت الفترة التجريبية لمؤسسة ' || r.org_name || '. البرنامج متوقف مؤقتًا وكل بياناتك محفوظة. أدخل كود تفعيل بعد تسجيل الدخول، أو تواصل معنا وسيعود كل شيء كما كان (رقم الترخيص ' || r.license_number || '):' || v_contacts ||
                E'\n\nThe trial of ' || r.org_name || ' has ended. The app is paused and all your data is kept. Enter an activation code after signing in, or contact us and everything returns as it was (license ' || r.license_number || '):' || v_contacts,
                'LICENSE', r.organization_id, jsonb_build_object('licenseNumber', r.license_number, 'expiresAt', r.expires_at));
            update license_activation_state set trial_ended_notice_sent_at = now() where license_activation_state.organization_id = r.organization_id;
        end if;
        kind := r.k; organization_id := r.organization_id; organization_name := r.org_name; owner_email := r.owner_email;
        license_number := r.license_number; expires_at := r.expires_at;
        return next;
    end loop;
end;
$$;
revoke execute on function public.claim_prosm_time_trial_notices() from public, anon, authenticated;

-- Hourly: send-trial-notices is called with a private secret kept in the vault
-- (created outside this file, never committed).
create extension if not exists pg_net;
select cron.unschedule('prosm-time-trial-notices') where exists (select 1 from cron.job where jobname = 'prosm-time-trial-notices');
select cron.schedule('prosm-time-trial-notices', '7 * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/send-trial-notices',
        headers := jsonb_build_object('Content-Type', 'application/json',
            'x-trial-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'trial_notices_secret' limit 1)),
        body := '{}'::jsonb)
    where exists (select 1 from vault.decrypted_secrets where name = 'trial_notices_secret');
$cron$);
