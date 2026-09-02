import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export type KioskMode = "personal_device_only" | "kiosk_only" | "both_allowed";
export type BreakRoundingMode = "cumulative" | "full_hour";

export interface Site {
  id: string;
  name: string;
  displayAddress: string | null;
  latitude: number;
  longitude: number;
  allowedRadiusMeters: number;
  gpsAccuracyToleranceMeters: number;
  timezone: string;
  isActive: boolean;
  attendanceAllowed: boolean;
  geofenceRequired: boolean;
  cameraRequired: boolean;
  environmentalTagEnabled: boolean;
  kioskMode: KioskMode;
  graceToleranceMinutes: number;
  // § live UX review, user-directed - per-site shift policy: work
  // hours (from/to), the hour overtime starts, the hour a lateness
  // deduction starts, whether break time rounds to a full locked
  // hour, and whether a self clock-in is blocked past the grace
  // period (requiring a manager-assisted clock-in instead). "HH:MM"
  // strings (or null = not configured, every behavior below stays a
  // no-op) - matches <input type="time">'s own value format.
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  overtimeStartTime: string | null;
  lateDeductionStartTime: string | null;
  breakRoundingMode: BreakRoundingMode;
  blockSelfClockInAfterGrace: boolean;
  createdAt: string;
}

export interface SiteAssignment {
  id: string;
  siteId: string;
  userId: string;
  roleAtSite: "member" | "manager";
  userFullName: string;
  userEmail: string;
}

export interface SiteInput {
  name: string;
  displayAddress: string | null;
  latitude: number;
  longitude: number;
  allowedRadiusMeters: number;
  gpsAccuracyToleranceMeters: number;
  timezone: string;
  attendanceAllowed: boolean;
  geofenceRequired: boolean;
  cameraRequired: boolean;
  environmentalTagEnabled: boolean;
  kioskMode: KioskMode;
  graceToleranceMinutes: number;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  overtimeStartTime: string | null;
  lateDeductionStartTime: string | null;
  breakRoundingMode: BreakRoundingMode;
  blockSelfClockInAfterGrace: boolean;
  // update-only: explicitly blanks out an already-configured shift
  // policy (time fields have no other "unset" signal once a real
  // time has been set, since the RPC's coalesce-based partial update
  // treats null as "keep current value" for every other field).
  clearShiftPolicy?: boolean;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface SiteRow {
  id: string;
  name: string;
  display_address: string | null;
  latitude: number;
  longitude: number;
  allowed_radius_meters: number;
  gps_accuracy_tolerance_meters: number;
  timezone: string;
  is_active: boolean;
  attendance_allowed: boolean;
  geofence_required: boolean;
  camera_required: boolean;
  environmental_tag_enabled: boolean;
  kiosk_mode: KioskMode;
  grace_tolerance_minutes: number;
  shift_start_time: string | null;
  shift_end_time: string | null;
  overtime_start_time: string | null;
  late_deduction_start_time: string | null;
  break_rounding_mode: BreakRoundingMode;
  block_self_clock_in_after_grace: boolean;
  created_at: string;
}

// Postgres' `time` column comes back over PostgREST as "HH:MM:SS" -
// truncated to "HH:MM" to match <input type="time">'s own value
// format exactly (and sent back the same way; Postgres parses
// "HH:MM" as a valid time literal without seconds).
function toHhMm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function mapSiteRow(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    displayAddress: row.display_address,
    latitude: row.latitude,
    longitude: row.longitude,
    allowedRadiusMeters: row.allowed_radius_meters,
    gpsAccuracyToleranceMeters: row.gps_accuracy_tolerance_meters,
    timezone: row.timezone,
    isActive: row.is_active,
    attendanceAllowed: row.attendance_allowed,
    geofenceRequired: row.geofence_required,
    cameraRequired: row.camera_required,
    environmentalTagEnabled: row.environmental_tag_enabled,
    kioskMode: row.kiosk_mode,
    graceToleranceMinutes: row.grace_tolerance_minutes,
    shiftStartTime: toHhMm(row.shift_start_time),
    shiftEndTime: toHhMm(row.shift_end_time),
    overtimeStartTime: toHhMm(row.overtime_start_time),
    lateDeductionStartTime: toHhMm(row.late_deduction_start_time),
    breakRoundingMode: row.break_rounding_mode,
    blockSelfClockInAfterGrace: row.block_self_clock_in_after_grace,
    createdAt: row.created_at,
  };
}

interface SiteAssignmentRow {
  id: string;
  site_id: string;
  user_id: string;
  role_at_site: "member" | "manager";
  users: { full_name: string; email: string } | { full_name: string; email: string }[] | null;
}

function mapSiteAssignmentRow(row: SiteAssignmentRow): SiteAssignment {
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  return {
    id: row.id,
    siteId: row.site_id,
    userId: row.user_id,
    roleAtSite: row.role_at_site,
    userFullName: user?.full_name ?? "",
    userEmail: user?.email ?? "",
  };
}

// PROSM Time - §13 "Sites & Projects". Reads are RLS-scoped to the
// caller's own organization; every mutation is a real RPC
// (create/update_prosm_time_site, set/remove_prosm_time_site_assignment)
// that re-checks 'sites.manage' server-side - this repository enforces
// nothing itself.
class SiteRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listSites(): Promise<ServiceResult<Site[]>> {
    try {
      const { data, error } = await this.client.from("sites").select("*").order("name", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapSiteRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  // WP-06/§13: the sites a given employee is actually assigned to -
  // the same real authorization source clock_in_prosm_time_attendance()
  // itself checks server-side; this is only what the Clock In picker
  // offers, never the enforcement.
  async listAssignedSites(userId: string): Promise<ServiceResult<Site[]>> {
    try {
      const { data, error } = await this.client.from("site_assignments").select("sites(*)").eq("user_id", userId);
      if (error) return createError(error.message);
      const sites = (data ?? []).flatMap((row) => {
        const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
        return site ? [mapSiteRow(site)] : [];
      });
      return createSuccess(sites);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async getSite(siteId: string): Promise<ServiceResult<Site>> {
    try {
      const { data, error } = await this.client.from("sites").select("*").eq("id", siteId).maybeSingle();
      if (error) return createError(error.message);
      if (!data) return createError("Site not found.");
      return createSuccess(mapSiteRow(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async createSite(input: SiteInput): Promise<ServiceResult<{ siteId: string }>> {
    try {
      const { data, error } = await this.client.rpc("create_prosm_time_site", {
        p_name: input.name,
        p_latitude: input.latitude,
        p_longitude: input.longitude,
        p_display_address: input.displayAddress,
        p_allowed_radius_meters: input.allowedRadiusMeters,
        p_gps_accuracy_tolerance_meters: input.gpsAccuracyToleranceMeters,
        p_timezone: input.timezone,
        p_attendance_allowed: input.attendanceAllowed,
        p_geofence_required: input.geofenceRequired,
        p_camera_required: input.cameraRequired,
        p_kiosk_mode: input.kioskMode,
        p_environmental_tag_enabled: input.environmentalTagEnabled,
        p_grace_tolerance_minutes: input.graceToleranceMinutes,
        p_shift_start_time: input.shiftStartTime,
        p_shift_end_time: input.shiftEndTime,
        p_overtime_start_time: input.overtimeStartTime,
        p_late_deduction_start_time: input.lateDeductionStartTime,
        p_break_rounding_mode: input.breakRoundingMode,
        p_block_self_clock_in_after_grace: input.blockSelfClockInAfterGrace,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to create this site.");
      return createSuccess({ siteId: data.siteId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async updateSite(siteId: string, input: SiteInput & { isActive: boolean }): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("update_prosm_time_site", {
        p_site_id: siteId,
        p_name: input.name,
        p_display_address: input.displayAddress,
        p_latitude: input.latitude,
        p_longitude: input.longitude,
        p_allowed_radius_meters: input.allowedRadiusMeters,
        p_gps_accuracy_tolerance_meters: input.gpsAccuracyToleranceMeters,
        p_timezone: input.timezone,
        p_attendance_allowed: input.attendanceAllowed,
        p_geofence_required: input.geofenceRequired,
        p_camera_required: input.cameraRequired,
        p_kiosk_mode: input.kioskMode,
        p_environmental_tag_enabled: input.environmentalTagEnabled,
        p_grace_tolerance_minutes: input.graceToleranceMinutes,
        p_is_active: input.isActive,
        p_shift_start_time: input.shiftStartTime,
        p_shift_end_time: input.shiftEndTime,
        p_overtime_start_time: input.overtimeStartTime,
        p_late_deduction_start_time: input.lateDeductionStartTime,
        p_break_rounding_mode: input.breakRoundingMode,
        p_block_self_clock_in_after_grace: input.blockSelfClockInAfterGrace,
        p_clear_shift_policy: input.clearShiftPolicy ?? false,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to update this site.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async listSiteAssignments(siteId: string): Promise<ServiceResult<SiteAssignment[]>> {
    try {
      const { data, error } = await this.client.from("site_assignments").select("id, site_id, user_id, role_at_site, users!site_assignments_user_id_fkey(full_name, email)").eq("site_id", siteId);
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapSiteAssignmentRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  // § live UX review, user-directed - the Dashboard's "Registered
  // employees" drill-down needs each employee's site name(s); no
  // existing read returns that org-wide (listSiteAssignments is
  // per-site). Relies on the same site_assignments RLS every other
  // read here already does - never a new authorization concept.
  async listAllAssignedSiteNames(): Promise<ServiceResult<Record<string, string[]>>> {
    try {
      const { data, error } = await this.client.from("site_assignments").select("user_id, sites(name)");
      if (error) return createError(error.message);
      const byUser: Record<string, string[]> = {};
      for (const row of data ?? []) {
        const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
        if (!site?.name) continue;
        (byUser[row.user_id] ??= []).push(site.name);
      }
      return createSuccess(byUser);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async setSiteAssignment(siteId: string, userId: string, roleAtSite: "member" | "manager"): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_site_assignment", {
        p_site_id: siteId,
        p_user_id: userId,
        p_role_at_site: roleAtSite,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to assign this employee to the site.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }

  async removeSiteAssignment(siteId: string, userId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("remove_prosm_time_site_assignment", {
        p_site_id: siteId,
        p_user_id: userId,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to remove this site assignment.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Site service unavailable.");
    }
  }
}

export default new SiteRepository();
