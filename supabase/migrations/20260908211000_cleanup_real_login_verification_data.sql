-- PROSM Time - removes the test leave request, its notifications, and
-- the (already-revoked) test API key row created while verifying the
-- leave-management + integrations features against a real
-- admin@prosm.net login (not the migration-level auth.uid() simulation
-- used elsewhere this session). Net effect on the schema after this
-- migration: none - these were never real user data.

begin;

delete from notifications where related_entity_id = 'cb036858-3554-4989-a743-fa1297985c1a';
delete from leave_requests where id = 'cb036858-3554-4989-a743-fa1297985c1a';
delete from api_keys where id = '94e40d48-d87f-4ce8-ad7d-bfa364e81b26';

commit;
