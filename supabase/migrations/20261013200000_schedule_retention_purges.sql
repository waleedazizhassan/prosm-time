-- Retention that was defined but never ran (found 2026-10-13 while
-- writing the privacy policy): location samples expire after 30 days and
-- camera evidence after 90 days (retention_expires_at), but nothing ever
-- deleted them. Two daily jobs now do:
-- * location samples - straight in the database;
-- * camera evidence - through the purge-camera-evidence Edge Function,
--   which removes the stored photo as well as its row. It needs the
--   service-role key, read from the vault secret
--   'prosm_time_service_role_key' (set once outside migrations, never in
--   Git); without the secret the job does nothing.

begin;

do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname in ('prosm-time-purge-location-samples', 'prosm-time-purge-camera-evidence');
exception
    when undefined_table then null;
end $$;

select cron.schedule('prosm-time-purge-location-samples', '15 3 * * *', $cron$
    select public.purge_prosm_time_expired_location_samples();
$cron$);

select cron.schedule('prosm-time-purge-camera-evidence', '30 3 * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/purge-camera-evidence',
        headers := jsonb_build_object('Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)),
        body := '{}'::jsonb)
    where exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key');
$cron$);

commit;
