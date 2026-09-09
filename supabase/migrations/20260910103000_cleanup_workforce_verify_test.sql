-- PROSM Time - removes the real test site worker (and its attendance
-- entry) created while independently live-verifying the new external-
-- workforce Kiosk system (commit f8903d5). Net effect: clean state.

begin;

delete from site_worker_attendance where site_worker_id = '7e2b2b17-3a3c-48c2-b6b9-5791534d1198';
delete from site_workers where id = '7e2b2b17-3a3c-48c2-b6b9-5791534d1198';

commit;
