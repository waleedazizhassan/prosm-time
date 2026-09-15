-- PROSM Time - user-directed (2026-09-15): "صلح موقع اكتوبر بس" - fix
-- ONLY the "October" site, not "hfjhf" (the other real site surfaced by
-- 20260915283000's confirmation query that still had
-- presence_monitoring_enabled=false). Same structural gap already
-- fixed on the other 3 real sites with the user's earlier go-ahead:
-- the toggle shipped 2026-09-07 but was never turned on here, which
-- blocks mid-shift "exited the geofence" detection entirely for this
-- site regardless of account.
update sites
set presence_monitoring_enabled = true
where name = 'October' and presence_monitoring_enabled = false;
