-- PROSM Time - fix for a real bug in the immediately preceding
-- migration (20260902140000), caught live during verification:
-- `revoke all on public.allowance_entries from anon, authenticated`
-- was never followed by the matching `grant select ... to
-- authenticated` every other RLS-protected table in this schema
-- carries (sites, timesheets, etc.) - RLS only restricts WHICH rows
-- are visible, the table-level GRANT is what allows the SELECT
-- statement to run at all. Without it, every authenticated read
-- failed outright with "permission denied for table
-- allowance_entries", regardless of RLS.

begin;

grant select on public.allowance_entries to authenticated;

commit;
