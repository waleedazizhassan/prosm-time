-- PROSM Time - real data correction for item 3 (2026-09-15), the
-- config half of the fix (code half is 20260915280000). Explicit user
-- go-ahead obtained before applying (touches live site config).
--
-- All 3 real sites were found (live query, 2026-09-15) sitting at:
--   gps_accuracy_tolerance_meters = 100  (schema default is 50 - see
--     20260831140000_wp05_sites_and_projects.sql; nothing in this
--     repo's history shows this was ever a deliberate per-site Owner
--     choice - stacked with allowed_radius_meters=100 it produced a
--     ~200m+ "at rest" effective geofence radius, which is what let
--     real violations go undetected for every account - see
--     20260915280000's own comment for the full reasoning)
--   presence_monitoring_enabled = false  (the toggle to turn this on
--     shipped 2026-09-07 per this repo's own memory - real per-site
--     UI exists in Settings > Site Policy - but it was never actually
--     turned on for any of the 3 real sites, which structurally blocks
--     ANY "exited the geofence while clocked in" detection, for every
--     account, since clock_in_prosm_time_attendance only opens a
--     presence_sessions row `if v_site.presence_monitoring_enabled`)
--
-- Both are real, live config values, not invented here - correcting
-- them is what makes item 3's reported behavior (notifications on
-- geofence exit / clock-out-location mismatch) actually start
-- working, on top of the code fixes already applied (Owner-skip bug
-- 20260915230000, stale overload 20260915232000, accuracy-cap
-- 20260915280000). If the Owner specifically wants a wider 100m site
-- tolerance again, it can be set from Settings > Site Policy.
update sites
set gps_accuracy_tolerance_meters = 50,
    presence_monitoring_enabled = true
where gps_accuracy_tolerance_meters = 100
  and presence_monitoring_enabled = false;
