-- PROSM Time - removes the real test leave request/notification created
-- while live-verifying 20260909310000's enriched notification content
-- (a genuine sick-leave request on admin@prosm.net, 2026-11-02 to
-- 2026-11-03). Net effect: back to a clean state.

begin;

delete from notifications where related_entity_id = 'cc31f679-c6fb-4594-890c-ae35c4a42f52';
delete from leave_requests where id = 'cc31f679-c6fb-4594-890c-ae35c4a42f52';

commit;
