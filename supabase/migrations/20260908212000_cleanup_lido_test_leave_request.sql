-- PROSM Time - removes the test leave request (and its notifications)
-- created while re-verifying the RLS fix with the real, standing Lido
-- test account (re-created via a real invite/redeem cycle this same
-- session - see the org-reset memory note). The Lido ACCOUNT itself is
-- deliberately kept - this is the new standing non-owner test login,
-- not a one-off. Net effect on the schema after this migration: the
-- account persists, only the throwaway leave request is gone.

begin;

delete from notifications where related_entity_id = '6476798d-3db0-4241-99e1-d3d260b212a0';
delete from leave_requests where id = '6476798d-3db0-4241-99e1-d3d260b212a0';

commit;
