-- 2026-11-03 (owner): "any change from the platform reaches the owner by email from
-- support@prosm.net, with a PDF of the new licence, automatically." The licence-change
-- notification (20261103110000) now always goes to send-push, which builds the PDF and
-- emails it to that owner. This function hands send-push what the email and PDF need.
-- Rollback: restore prosm_time_push_notification from 20261028160000; drop
-- get_prosm_time_license_email(uuid).

begin;

create or replace function public.prosm_time_push_notification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if (
           exists (select 1 from push_devices where user_id = new.user_id)
           or (new.related_entity_type = 'leave_requests' and coalesce(new.data ->> 'kind', '') in ('leave', 'leave_cancelled', 'leave_request_withdrawn'))
           or new.type = 'license_changed'
       )
       and exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key') then
        perform net.http_post(
            url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/send-push',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
            ),
            body := jsonb_build_object('notificationId', new.id)
        );
    end if;
    return new;
exception
    when others then
        -- A push is a best-effort extra; the notification itself always stays.
        return new;
end;
$function$;

create or replace function public.get_prosm_time_license_email(p_notification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'organizationId', n.organization_id,
        'to', u.email,
        'name', u.full_name,
        'organizationName', o.name,
        'licenseNumber', l.license_number,
        'status', l.status,
        'plan', coalesce(e.plan, 'legacy'),
        'maxUsers', l.max_users,
        'maxDevices', l.max_devices,
        'activeUsers', (select count(*) from users x where x.organization_id = n.organization_id and x.is_active),
        'expiresAt', l.expires_at,
        'data', n.data,
        'createdAt', n.created_at)
    from notifications n
    join users u on u.id = n.user_id
    join organizations o on o.id = n.organization_id
    join license_activation_state l on l.organization_id = n.organization_id
    left join entitlements e on e.organization_id = n.organization_id
    where n.id = p_notification_id and n.type = 'license_changed' and u.email is not null;
$$;
revoke all on function public.get_prosm_time_license_email(uuid) from public, anon, authenticated;
grant execute on function public.get_prosm_time_license_email(uuid) to service_role;

commit;
