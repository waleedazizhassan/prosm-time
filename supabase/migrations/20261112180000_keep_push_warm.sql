-- Owner 2026-11-12: "the emergency (SOS) notification must be very fast". Every notification already goes to
-- send-push the moment it is written (a trigger), and send-push sends to every phone at once. What could
-- still cost a second or two is send-push starting cold and fetching Google's access token. A ping every
-- minute keeps it started with the token ready.
-- Rollback: select cron.unschedule('prosm-time-keep-push-warm');

begin;

select cron.unschedule('prosm-time-keep-push-warm') where exists (select 1 from cron.job where jobname = 'prosm-time-keep-push-warm');
select cron.schedule('prosm-time-keep-push-warm', '* * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer warm'),
        body := jsonb_build_object('warm', true)
    );
$cron$);

commit;
