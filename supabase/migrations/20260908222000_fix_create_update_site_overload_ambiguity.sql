-- PROSM Time - real, live, production-breaking bug found incidentally
-- while creating a test site for shift-scheduling verification: the
-- standard "Add Site" form (SitesPage.tsx) has never set
-- presenceMonitoringEnabled, so the real request body never includes
-- p_presence_monitoring_enabled at all (JSON.stringify drops undefined
-- keys) - and two live overloads of create_prosm_time_site have
-- existed simultaneously since 20260907100000 shipped (confirmed via
-- pg_proc in 20260908221000's own diagnostic, not assumption), so
-- PostgREST cannot choose between them and every real "Add Site" via
-- the standard flow has been failing outright with PGRST203 "Could not
-- choose the best candidate function" since 2026-09-07. update_prosm_
-- time_site has the identical gap (also confirmed live) - the same
-- SiteRepository.ts update path likely hits it whenever an edit omits
-- the field too.
--
-- 20260907100000's own header comment claimed "create or replace is
-- sufficient... no drop needed" - that is factually wrong (this
-- session's own repeatedly-confirmed lesson, prosm-projects
-- af3e18f/7ca0a95 and prosm-time itself elsewhere: appending a
-- parameter changes a function's identity in Postgres, it does not
-- replace the old overload - only an exactly-matching signature does).
-- Drops the two stale pre-presence-monitoring overloads (exact
-- signatures read from pg_proc, not reconstructed from migration
-- history) - the newer ones already correctly default
-- p_presence_monitoring_enabled to false when omitted.

begin;

drop function if exists public.create_prosm_time_site(
    p_name text, p_latitude double precision, p_longitude double precision, p_display_address text,
    p_allowed_radius_meters integer, p_gps_accuracy_tolerance_meters integer, p_timezone text,
    p_attendance_allowed boolean, p_geofence_required boolean, p_camera_required boolean, p_kiosk_mode text,
    p_grace_tolerance_minutes integer, p_shift_start_time time, p_shift_end_time time, p_overtime_start_time time,
    p_late_deduction_start_time time, p_break_rounding_mode text, p_block_self_clock_in_after_grace boolean,
    p_block_self_clock_out_outside_geofence boolean
);

drop function if exists public.update_prosm_time_site(
    p_site_id uuid, p_name text, p_display_address text, p_latitude double precision, p_longitude double precision,
    p_allowed_radius_meters integer, p_gps_accuracy_tolerance_meters integer, p_timezone text,
    p_attendance_allowed boolean, p_geofence_required boolean, p_camera_required boolean, p_kiosk_mode text,
    p_grace_tolerance_minutes integer, p_is_active boolean, p_shift_start_time time, p_shift_end_time time,
    p_overtime_start_time time, p_late_deduction_start_time time, p_break_rounding_mode text,
    p_block_self_clock_in_after_grace boolean, p_clear_shift_policy boolean, p_block_self_clock_out_outside_geofence boolean
);

commit;
