-- Owner 2026-10-20 ("the dashboard doesn't update - no charts, no cards"):
-- since 20261018130000 attendance_sessions had TWO foreign keys to sites
-- (site_id and responsible_site_id), so every app query embedding
-- "sites(name)" from a shift was refused by the API as ambiguous
-- (PGRST201) - the dashboard, the Attendance Record and the reports came
-- back empty. responsible_site_id keeps its value (set by trigger from the
-- sites table, and sites are deactivated rather than deleted) but no longer
-- carries a foreign key, so "sites" from a shift means its own site again -
-- for every installed app at once, with no update needed.

begin;

alter table public.attendance_sessions drop constraint if exists attendance_sessions_responsible_site_id_fkey;

commit;
