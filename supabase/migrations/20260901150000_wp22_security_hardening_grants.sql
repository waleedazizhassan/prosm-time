-- PROSM Time Implementation Master File V3.0, WP-22 (Security
-- Hardening | §24). "RLS audit, authorization tests, storage security,
-- abuse controls, privacy/retention, data-subject rights."
--
-- Real audit performed via `supabase db advisors --type security`
-- (Supabase's own Postgres security linter) against the live linked
-- project. Findings and disposition:
--
-- 1. `rls_enabled_no_policy` on `user_invitations` (INFO) - reviewed,
--    NOT a gap: this table intentionally has RLS enabled + `revoke all
--    from anon, authenticated` + no policies (WP-04's own migration
--    already comments this explicitly) - it is only ever reached
--    through SECURITY DEFINER RPCs, never a direct client query. No
--    change.
--
-- 2. `function_search_path_mutable` on `generate_organization_code`
--    (WARN) - a real, missed instance of the `set search_path = public`
--    convention used on every other function in this codebase (guards
--    against search_path-hijacking via schema squatting). Fixed below
--    via ALTER FUNCTION rather than touching the WP-03 migration file.
--
-- 3. `anon_security_definer_function_executable` /
--    `authenticated_security_definer_function_executable` (WARN, ~44
--    functions) - the real, systemic finding: only
--    compute_prosm_time_geofence_check/compute_prosm_time_daily_overtime
--    (WP-09/WP-12) and the WP-13 notification helpers had ever
--    explicitly revoked EXECUTE from anon/public - every other
--    SECURITY DEFINER RPC built from WP-06 onward kept Postgres's
--    default EXECUTE-to-PUBLIC grant, meaning an entirely
--    unauthenticated caller could invoke them directly (the function's
--    own `current_prosm_time_user_id() is null` check still correctly
--    rejected every one of them - this was never an open door, but a
--    missing layer of defense-in-depth the advisor is right to flag).
--    Fixed below for every one of them: EXECUTE revoked from
--    public/anon, kept for `authenticated` (every one of these is
--    genuinely called either directly from a repository's own
--    `.rpc()` or from an Edge Function forwarding the caller's own JWT
--    - verified by grep across src/core/repositories, src/core/offline,
--    and supabase/functions/*/index.ts before compiling this list).
--
--    Two functions in that flagged set - prosm_time_user_has_permission_internal
--    and notify_prosm_time_timesheet_approvers (WP-16) - are, unlike
--    every other flagged function, NEVER called directly by any client
--    or Edge Function; they are purely internal (only ever invoked via
--    `perform`/`select` from within another SECURITY DEFINER function,
--    a call path that runs as the function owner and is unaffected by
--    revoking authenticated/anon grants). These get EXECUTE revoked
--    from authenticated too, matching the exact pattern WP-13's own
--    create_prosm_time_notification/notify_prosm_time_supervisors
--    already used (which is why the advisor never flagged those two -
--    they were already done correctly).
--
--    CRITICAL: current_prosm_time_user_id(), current_prosm_time_organization_id()
--    and current_prosm_time_user_is_owner() were ALSO flagged, but must
--    NEVER have `authenticated` revoked - they are referenced inside
--    the USING clause of nearly every RLS policy in this database, and
--    RLS policy expressions are evaluated as the querying role
--    (`authenticated` for every real signed-in request). Revoking
--    authenticated execute on them would have broken every RLS-
--    protected read in the entire application. Verified via grep
--    (`current_prosm_time_(user_id|organization_id|user_is_owner)`
--    appears inside `using (...)` clauses 24+ times) before deciding
--    this. Only `anon`/`public` are revoked for these three (safe:
--    grep also confirmed no table in this schema ever grants SELECT to
--    `anon`, so an anonymous caller can never reach a policy
--    evaluation that would need them anyway).
--
-- 4. `auth_leaked_password_protection` (WARN) - a Supabase Auth
--    project SETTING (HaveIBeenPwned check on password creation), not
--    a schema/migration change - enabled directly in the Supabase
--    dashboard's Auth settings, out of migration-file scope. Documented
--    as a deferred manual step in the final report, not silently
--    skipped.

begin;

-- ---- Fix 2: mutable search_path ----
alter function public.generate_organization_code() set search_path = public;

-- ---- Fix 3a: revoke anon/public, keep authenticated (client/Edge-facing RPCs) ----
revoke execute on function public.admin_clock_in_prosm_time_attendance(p_subject_user_id uuid, p_site_id uuid, p_reason text, p_project_id uuid, p_idempotency_key text, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision, p_device_info text) from public, anon;
revoke execute on function public.admin_clock_out_prosm_time_attendance(p_subject_user_id uuid, p_reason text, p_idempotency_key text, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision, p_device_info text) from public, anon;
revoke execute on function public.admin_set_prosm_time_kiosk_pin(p_user_id uuid, p_pin text) from public, anon;
revoke execute on function public.approve_prosm_time_timesheet(p_timesheet_id uuid, p_action text, p_notes text) from public, anon;
revoke execute on function public.attach_prosm_time_camera_evidence(p_attendance_event_id uuid, p_storage_path text, p_content_type text, p_file_size_bytes integer) from public, anon;
revoke execute on function public.clear_prosm_time_user_permission_override(p_target_user_id uuid, p_permission_key text, p_reason text) from public, anon;
revoke execute on function public.clock_in_prosm_time_attendance(p_site_id uuid, p_idempotency_key text, p_project_id uuid, p_client_reported_at timestamp with time zone, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision) from public, anon;
revoke execute on function public.clock_out_prosm_time_attendance(p_idempotency_key text, p_client_reported_at timestamp with time zone, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision) from public, anon;
revoke execute on function public.compute_prosm_time_daily_overtime(p_user_id uuid, p_date date) from public, anon;
revoke execute on function public.compute_prosm_time_geofence_check(p_site_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision) from public, anon;
revoke execute on function public.create_prosm_time_project(p_site_id uuid, p_name text, p_code text, p_description text) from public, anon;
revoke execute on function public.create_prosm_time_site(p_name text, p_latitude double precision, p_longitude double precision, p_display_address text, p_allowed_radius_meters integer, p_gps_accuracy_tolerance_meters integer, p_timezone text, p_attendance_allowed boolean, p_geofence_required boolean, p_camera_required boolean, p_kiosk_mode text, p_environmental_tag_enabled boolean, p_grace_tolerance_minutes integer) from public, anon;
revoke execute on function public.end_prosm_time_break(p_break_id uuid) from public, anon;
revoke execute on function public.end_prosm_time_presence_session(p_presence_session_id uuid, p_reason text) from public, anon;
revoke execute on function public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date) from public, anon;
revoke execute on function public.get_prosm_time_effective_permissions(p_user_id uuid) from public, anon;
revoke execute on function public.kiosk_clock_in_prosm_time_attendance(p_site_id uuid, p_employee_user_id uuid, p_pin text, p_idempotency_key text, p_project_id uuid, p_client_reported_at timestamp with time zone) from public, anon;
revoke execute on function public.kiosk_clock_out_prosm_time_attendance(p_site_id uuid, p_employee_user_id uuid, p_pin text, p_idempotency_key text, p_client_reported_at timestamp with time zone) from public, anon;
revoke execute on function public.list_prosm_time_kiosk_roster(p_site_id uuid) from public, anon;
revoke execute on function public.list_prosm_time_timesheet_entries(p_timesheet_id uuid) from public, anon;
revoke execute on function public.list_prosm_time_timesheet_evidence_pack(p_timesheet_id uuid) from public, anon;
revoke execute on function public.mark_prosm_time_notification_read(p_notification_id uuid) from public, anon;
revoke execute on function public.record_prosm_time_presence_sample(p_presence_session_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision, p_client_reported_at timestamp with time zone) from public, anon;
revoke execute on function public.remove_prosm_time_project_assignment(p_project_id uuid, p_user_id uuid) from public, anon;
revoke execute on function public.remove_prosm_time_site_assignment(p_site_id uuid, p_user_id uuid) from public, anon;
revoke execute on function public.request_prosm_time_timesheet_correction(p_timesheet_id uuid, p_reason text) from public, anon;
revoke execute on function public.resolve_prosm_time_sos_alert(p_sos_alert_id uuid, p_resolution_notes text) from public, anon;
revoke execute on function public.review_prosm_time_exception(p_kind text, p_target_id uuid, p_action_type text, p_notes text) from public, anon;
revoke execute on function public.review_prosm_time_timesheet_correction(p_correction_id uuid, p_action text, p_notes text) from public, anon;
revoke execute on function public.set_prosm_time_device_binding_status(p_device_binding_id uuid, p_status text, p_reason text) from public, anon;
revoke execute on function public.set_prosm_time_kiosk_pin(p_pin text) from public, anon;
revoke execute on function public.set_prosm_time_project_assignment(p_project_id uuid, p_user_id uuid) from public, anon;
revoke execute on function public.set_prosm_time_site_assignment(p_site_id uuid, p_user_id uuid, p_role_at_site text) from public, anon;
revoke execute on function public.set_prosm_time_user_permission_override(p_target_user_id uuid, p_permission_key text, p_is_granted boolean, p_reason text) from public, anon;
revoke execute on function public.start_prosm_time_break(p_attendance_session_id uuid, p_idempotency_key text) from public, anon;
revoke execute on function public.submit_prosm_time_correction_request(p_attendance_session_id uuid, p_proposed_event_type text, p_proposed_correct_time timestamp with time zone, p_reason text) from public, anon;
revoke execute on function public.submit_prosm_time_exception_reason(p_exception_id uuid, p_reason_category text, p_reason text) from public, anon;
revoke execute on function public.submit_prosm_time_timesheet(p_timesheet_id uuid) from public, anon;
revoke execute on function public.trigger_prosm_time_sos_alert(p_presence_session_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_meters double precision) from public, anon;
revoke execute on function public.update_prosm_time_project(p_project_id uuid, p_name text, p_code text, p_description text, p_is_active boolean) from public, anon;
revoke execute on function public.update_prosm_time_site(p_site_id uuid, p_name text, p_display_address text, p_latitude double precision, p_longitude double precision, p_allowed_radius_meters integer, p_gps_accuracy_tolerance_meters integer, p_timezone text, p_attendance_allowed boolean, p_geofence_required boolean, p_camera_required boolean, p_kiosk_mode text, p_environmental_tag_enabled boolean, p_grace_tolerance_minutes integer, p_is_active boolean) from public, anon;

-- ---- Fix 3b: revoke anon/public only (authenticated required by RLS policies - see header) ----
revoke execute on function public.current_prosm_time_organization_id() from public, anon;
revoke execute on function public.current_prosm_time_user_id() from public, anon;
revoke execute on function public.current_prosm_time_user_is_owner() from public, anon;

-- ---- Fix 3c: fully internal-only (never called by any client or Edge Function directly) ----
revoke execute on function public.prosm_time_user_has_permission_internal(p_user_id uuid, p_permission_key text) from public, anon, authenticated;
revoke execute on function public.notify_prosm_time_timesheet_approvers(p_organization_id uuid, p_type text, p_priority text, p_title text, p_body text, p_related_entity_type text, p_related_entity_id uuid) from public, anon, authenticated;

commit;
