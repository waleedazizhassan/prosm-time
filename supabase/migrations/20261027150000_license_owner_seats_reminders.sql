-- v2.3.55 (owner 2026-10-27):
--   * "the licence details - its number, the user count and so on - are the
--     Owner's to see": the licence row is readable by the Owner only (it was
--     every member's), the trial check gives the licence number to the Owner
--     only, and the seat count answers the Owner only;
--   * "stop adding users beyond the licence": a person added or reactivated
--     when the organisation already has as many active people as the licence
--     allows is refused (every path - invitation, activation, reactivation -
--     goes through the users table, so the check sits there);
--   * "warn before the licence ends": the hourly trial-notice job also
--     reminds the Owner a month and a week before a paid licence ends
--     (notification, phone push and email).
-- claim_prosm_time_trial_notices and get_prosm_time_trial_status are the
-- live definitions with these additions.

begin;

-- 1. the licence is the Owner's
drop policy if exists "members can view own organization license state" on public.license_activation_state;
create policy "owner can view own organization license state" on public.license_activation_state
    for select to authenticated
    using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

create or replace function public.get_prosm_time_trial_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select coalesce((
        select jsonb_build_object(
            'isTrial', l.is_trial,
            'locked', l.is_trial and l.expires_at is not null and l.expires_at <= now(),
            'expiresAt', l.expires_at,
            'daysLeft', case when l.expires_at is null then null else greatest(0, ceil(extract(epoch from (l.expires_at - now())) / 86400)::int) end,
            -- v2.3.55: the licence number is the Owner's to see
            'licenseNumber', case when u.is_owner then l.license_number else null end,
            'isOwner', u.is_owner,
            'organizationName', o.name,
            'serverTime', now())
        from users u
        join license_activation_state l on l.organization_id = u.organization_id
        join organizations o on o.id = u.organization_id
        where u.auth_user_id = auth.uid() and u.is_active = true
        limit 1), jsonb_build_object('isTrial', false, 'locked', false));
$function$;

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
        'maxUsers', (select max_users from license_activation_state where organization_id = v_org)
    );
end;
$function$;

-- 2. no more active people than the licence allows
create or replace function public.prosm_time_enforce_licensed_users()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_max integer;
    v_active integer;
begin
    if not new.is_active or (tg_op = 'UPDATE' and old.is_active and old.organization_id = new.organization_id) then
        return new;
    end if;
    select max_users into v_max from license_activation_state where organization_id = new.organization_id;
    if v_max is null or v_max <= 0 then return new; end if;
    -- one at a time per organisation, so two invitations cannot both take the last place
    perform pg_advisory_xact_lock(hashtext('prosm_time_seats_' || new.organization_id::text));
    select count(*) into v_active from users where organization_id = new.organization_id and is_active and id <> new.id;
    if v_active >= v_max then
        raise exception 'LICENSED USER LIMIT REACHED';
    end if;
    return new;
end;
$function$;

revoke all on function public.prosm_time_enforce_licensed_users() from public, anon, authenticated;

drop trigger if exists users_enforce_licensed_users on public.users;
create trigger users_enforce_licensed_users
before insert or update of is_active, organization_id on public.users
for each row execute function public.prosm_time_enforce_licensed_users();

-- 3. reminders before a paid licence ends
alter table public.license_activation_state add column if not exists license_month_notice_for timestamptz;
alter table public.license_activation_state add column if not exists license_week_notice_for timestamptz;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended', 'timesheet_ready',
    'allowance_submitted', 'allowance_approved', 'allowance_rejected',
    'long_session_check', 'session_auto_closed', 'exit_site_prompt', 'auto_checkout_geofence',
    'clock_in_reminder', 'clock_out_reminder', 'license_ending']));

create or replace function public.claim_prosm_time_trial_notices()
 RETURNS TABLE(kind text, organization_id uuid, organization_name text, owner_email text, license_number text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            values (r.organization_id, r.owner_id, 'trial_ending', 'high',
                'تنتهي الفترة التجريبية لـ PROSM Time في ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || ' | Your PROSM Time trial ends on ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD'),
                'تنتهي الفترة التجريبية لمؤسسة ' || r.org_name || ' بعد أسبوع. بياناتك محفوظة ولن تُحذف. للاستمرار اشترِ كود تفعيل وأدخله في البرنامج، أو تواصل معنا لتجديد الترخيص (رقم الترخيص ' || r.license_number || '):' || v_contacts ||
                E'\n\nThe trial of ' || r.org_name || ' ends in a week. Your data is kept and will not be deleted. To continue, buy an activation code and enter it in the app, or contact us to renew the license (license ' || r.license_number || '):' || v_contacts,
                'LICENSE', r.organization_id, jsonb_build_object('licenseNumber', r.license_number, 'expiresAt', r.expires_at));
            update license_activation_state set trial_reminder_sent_at = now() where license_activation_state.organization_id = r.organization_id;
        else
            insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
            values (r.organization_id, r.owner_id, 'trial_ended', 'high',
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

    -- v2.3.55 (owner 2026-10-27): a paid licence - a month and a week before it
    -- ends, once each for that end date (a renewal with a new date reminds again).
    for r in
        select l.organization_id, l.license_number, l.expires_at, o.name as org_name, u.id as owner_id, u.email as owner_email,
               case when l.expires_at <= now() + interval '7 days' then 'LICENSE_WEEK' else 'LICENSE_MONTH' end as k
        from license_activation_state l
        join organizations o on o.id = l.organization_id
        join users u on u.organization_id = l.organization_id and u.is_owner and u.is_active
        where not l.is_trial and l.expires_at is not null and l.expires_at > now()
          and (
              (l.expires_at <= now() + interval '7 days' and l.license_week_notice_for is distinct from l.expires_at)
              or (l.expires_at > now() + interval '7 days' and l.expires_at <= now() + interval '30 days' and l.license_month_notice_for is distinct from l.expires_at)
          )
        for update of l skip locked
    loop
        insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
        values (r.organization_id, r.owner_id, 'license_ending', 'high',
            'ينتهي ترخيص PROSM Time في ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || ' | Your PROSM Time licence ends on ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD'),
            'ينتهي ترخيص مؤسسة ' || r.org_name || ' (رقم الترخيص ' || r.license_number || ') في ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || '. جدّد الترخيص قبل هذا التاريخ ليستمر البرنامج دون توقف، وتبقى كل بياناتك محفوظة:' || v_contacts ||
            E'\n\nThe licence of ' || r.org_name || ' (licence ' || r.license_number || ') ends on ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || '. Renew it before then so the app keeps running; all your data is kept:' || v_contacts,
            'LICENSE', r.organization_id, jsonb_build_object('licenseNumber', r.license_number, 'expiresAt', r.expires_at, 'kind', r.k));
        if r.k = 'LICENSE_WEEK' then
            -- a week before also covers the month's reminder if that one never went
            update license_activation_state set license_week_notice_for = r.expires_at, license_month_notice_for = r.expires_at where license_activation_state.organization_id = r.organization_id;
        else
            update license_activation_state set license_month_notice_for = r.expires_at where license_activation_state.organization_id = r.organization_id;
        end if;
        kind := r.k; organization_id := r.organization_id; organization_name := r.org_name; owner_email := r.owner_email;
        license_number := r.license_number; expires_at := r.expires_at;
        return next;
    end loop;
end;
$function$;

commit;
