-- PROSM Time - removes the test site/shift template/shift assignment/
-- notifications created while verifying shift-scheduling end to end
-- with real admin@prosm.net + Lido logins. Net effect on the schema:
-- back to the same clean "admin@prosm.net only, zero data" state as
-- after the earlier org reset - this was test data, not something the
-- user asked to keep.

begin;

delete from notifications where type = 'shift_assigned';
delete from shift_assignments where notes = 'Verification shift';
delete from shift_templates where name = 'Morning' and color = '#f59e0b';
delete from sites where name in ('Main Site', 'Main Site Updated');

commit;
