-- Removes the real test site worker/attendance entry created while
-- live-verifying the kiosk-worker-clock-in/out Edge Functions via curl.
begin;
delete from site_worker_attendance where site_worker_id = 'f07f56e3-859a-4874-917c-665fd433e959';
delete from site_workers where id = 'f07f56e3-859a-4874-917c-665fd433e959';
commit;
