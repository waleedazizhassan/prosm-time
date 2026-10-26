-- v2.3.54 (owner 2026-10-26, found in the live leave test): the notification
-- trigger called send-push only for someone with a registered phone, so the
-- leave emails (20261026130000) never left for a reviewer without the app on
-- a phone. A leave notification now always reaches send-push, which emails
-- it and pushes it where there is a phone.

begin;

create or replace function public.prosm_time_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if (
           exists (select 1 from push_devices where user_id = new.user_id)
           or (new.related_entity_type = 'leave_requests' and coalesce(new.data ->> 'kind', '') = 'leave')
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

commit;
