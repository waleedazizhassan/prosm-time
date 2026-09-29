-- Follow-up to 20260929100000_demo_trial: PROSM Time notification types are lowercase and
-- limited by a check constraint - the two trial notices are added (every existing type kept).

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review', 'correction_submitted', 'correction_reviewed',
    'break_exceeded', 'sos_alert', 'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected', 'shift_assigned',
    'site_change_alert', 'missing_clock_out', 'location_plausibility_flag', 'trial_ending', 'trial_ended']));

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
end;
$$;
revoke execute on function public.claim_prosm_time_trial_notices() from public, anon, authenticated;
