-- 2026-11-01 (plan stage 3.6): the owner is told the day before a trial or a paid
-- plan ends, and notices say to contact sales, with no purchase wording (Play
-- policy). The live body with only these changes.
-- Rollback: restore the function and drop both columns.

begin;

alter table public.license_activation_state
    add column trial_day_notice_sent_at timestamptz,
    add column license_day_notice_for timestamptz;

CREATE OR REPLACE FUNCTION public.claim_prosm_time_trial_notices()
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
               case when l.expires_at <= now() then 'ENDED' when l.expires_at <= now() + interval '1 day' and l.trial_reminder_sent_at is not null then 'ENDING_DAY' else 'ENDING' end as k
        from license_activation_state l
        join organizations o on o.id = l.organization_id
        join users u on u.organization_id = l.organization_id and u.is_owner and u.is_active
        where l.is_trial and l.expires_at is not null
          and ((l.expires_at > now() and l.expires_at <= now() + interval '7 days' and l.trial_reminder_sent_at is null)
            or (l.expires_at > now() and l.expires_at <= now() + interval '1 day' and l.trial_reminder_sent_at is not null and l.trial_day_notice_sent_at is null)
            or (l.expires_at <= now() and l.trial_ended_notice_sent_at is null))
        for update of l skip locked
    loop
        if r.k = 'ENDING_DAY' then
            insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
            values (r.organization_id, r.owner_id, 'trial_ending', 'high',
                'تنتهي الفترة التجريبية لـ PROSM Time غدًا | Your PROSM Time trial ends tomorrow',
                'تنتهي الفترة التجريبية لمؤسسة ' || r.org_name || ' غدًا. بياناتك محفوظة ولن تُحذف.' || E'

The trial of ' || r.org_name || ' ends tomorrow. Your data is kept and will not be deleted.',
                'LICENSE', r.organization_id, jsonb_build_object('licenseNumber', r.license_number, 'expiresAt', r.expires_at));
            update license_activation_state set trial_day_notice_sent_at = now() where license_activation_state.organization_id = r.organization_id;
        elsif r.k = 'ENDING' then
            insert into notifications (organization_id, user_id, type, priority, title, body, related_entity_type, related_entity_id, data)
            values (r.organization_id, r.owner_id, 'trial_ending', 'high',
                'تنتهي الفترة التجريبية لـ PROSM Time في ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') || ' | Your PROSM Time trial ends on ' || to_char(r.expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD'),
                'تنتهي الفترة التجريبية لمؤسسة ' || r.org_name || ' بعد أسبوع. بياناتك محفوظة ولن تُحذف. للاستمرار تواصل مع فريق المبيعات لتجديد الترخيص (رقم الترخيص ' || r.license_number || '):' || v_contacts ||
                E'\n\nThe trial of ' || r.org_name || ' ends in a week. Your data is kept and will not be deleted. To continue, contact the sales team to renew the license (license ' || r.license_number || '):' || v_contacts,
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
               case when l.expires_at <= now() + interval '1 day' then 'LICENSE_DAY' when l.expires_at <= now() + interval '7 days' then 'LICENSE_WEEK' else 'LICENSE_MONTH' end as k
        from license_activation_state l
        join organizations o on o.id = l.organization_id
        join users u on u.organization_id = l.organization_id and u.is_owner and u.is_active
        where not l.is_trial and l.expires_at is not null and l.expires_at > now()
          and (
              (l.expires_at <= now() + interval '1 day' and l.license_day_notice_for is distinct from l.expires_at)
              or (l.expires_at > now() + interval '1 day' and l.expires_at <= now() + interval '7 days' and l.license_week_notice_for is distinct from l.expires_at)
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
        if r.k = 'LICENSE_DAY' then
            update license_activation_state set license_day_notice_for = r.expires_at, license_week_notice_for = r.expires_at, license_month_notice_for = r.expires_at where license_activation_state.organization_id = r.organization_id;
        elsif r.k = 'LICENSE_WEEK' then
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
