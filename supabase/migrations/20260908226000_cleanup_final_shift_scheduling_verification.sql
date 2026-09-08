-- PROSM Time - removes the final round of shift-scheduling
-- verification data (a real site, template, and assignment created
-- while re-testing after the overnight-shift limitation clarification
-- and confirming the frontend-shaped RPC calls work end to end with
-- real admin@prosm.net + Lido logins). Net effect: org back to its
-- clean "admin@prosm.net only" state.

begin;

delete from notifications where type = 'shift_assigned';
delete from shift_assignments where site_id in (select id from sites where name = 'Downtown Site');
delete from shift_templates where site_id in (select id from sites where name = 'Downtown Site');
delete from sites where name = 'Downtown Site';

commit;
