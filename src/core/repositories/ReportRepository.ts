import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

export interface WorkforceRow {
  userId: string;
  fullName: string;
  email: string;
  roleName: string;
  isOwner: boolean;
  siteNames: string;
  status: string;
  createdAt: string;
}

export interface SiteSummaryRow {
  siteId: string;
  siteName: string;
  employeeCount: number;
  totalHours: number;
  exceptionCount: number;
}

export interface LateRow {
  sessionId: string;
  userFullName: string;
  siteName: string;
  shiftStartTime: string;
  clockInAt: string;
  minutesLate: number;
}

export interface MissingCheckoutRow {
  sessionId: string;
  userFullName: string;
  siteName: string;
  clockInAt: string;
  hoursOpen: number;
  stillOpen: boolean;
}

export interface LeaveConflictRow {
  sessionId: string;
  userFullName: string;
  siteName: string;
  clockInAt: string;
  leaveType: string;
  leaveStartDate: string;
  leaveEndDate: string;
}

export interface ManagerOverrideRow {
  auditLogId: string;
  actorName: string;
  subjectName: string;
  action: string;
  description: string;
  reason: string;
  createdAt: string;
}

export interface LocationViolationRow {
  flagId: string;
  userFullName: string;
  siteName: string;
  impliedSpeedKmh: number;
  distanceMeters: number;
  occurredAt: string;
}

// PROSM Time - 14-point live-audit gap #8: 7 real report types the
// Reports Center was missing (Workforce, Site, Late, Missing-Checkout,
// Leave-Conflict, Manager-Override, Location-Violations - Contractor
// reuses SiteWorkerRepository.listAttendance, already real). Each RPC
// here (20260910180000) is org-scoped and permission-checked
// server-side - this repository is a thin, typed wrapper, same pattern
// as every other repository in this codebase.
class ReportRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async workforce(): Promise<ServiceResult<WorkforceRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_workforce");
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map(
          (row: { user_id: string; full_name: string; email: string; role_name: string; is_owner: boolean; site_names: string; status: string; created_at: string }) => ({
            userId: row.user_id,
            fullName: row.full_name,
            email: row.email,
            roleName: row.role_name,
            isOwner: row.is_owner,
            siteNames: row.site_names,
            status: row.status,
            createdAt: row.created_at,
          }),
        ),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async siteSummary(startDate: string, endDate: string): Promise<ServiceResult<SiteSummaryRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_site_summary", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { site_id: string; site_name: string; employee_count: number; total_hours: number; exception_count: number }) => ({
          siteId: row.site_id,
          siteName: row.site_name,
          employeeCount: row.employee_count,
          totalHours: row.total_hours,
          exceptionCount: row.exception_count,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async late(startDate: string, endDate: string): Promise<ServiceResult<LateRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_late", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { session_id: string; user_full_name: string; site_name: string; shift_start_time: string; clock_in_at: string; minutes_late: number }) => ({
          sessionId: row.session_id,
          userFullName: row.user_full_name,
          siteName: row.site_name,
          shiftStartTime: row.shift_start_time,
          clockInAt: row.clock_in_at,
          minutesLate: row.minutes_late,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async missingCheckouts(startDate: string, endDate: string): Promise<ServiceResult<MissingCheckoutRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_missing_checkouts", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { session_id: string; user_full_name: string; site_name: string; clock_in_at: string; hours_open: number; still_open: boolean }) => ({
          sessionId: row.session_id,
          userFullName: row.user_full_name,
          siteName: row.site_name,
          clockInAt: row.clock_in_at,
          hoursOpen: row.hours_open,
          stillOpen: row.still_open,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async leaveConflicts(startDate: string, endDate: string): Promise<ServiceResult<LeaveConflictRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_leave_conflicts", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map(
          (row: { session_id: string; user_full_name: string; site_name: string; clock_in_at: string; leave_type: string; leave_start_date: string; leave_end_date: string }) => ({
            sessionId: row.session_id,
            userFullName: row.user_full_name,
            siteName: row.site_name,
            clockInAt: row.clock_in_at,
            leaveType: row.leave_type,
            leaveStartDate: row.leave_start_date,
            leaveEndDate: row.leave_end_date,
          }),
        ),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async managerOverrides(startDate: string, endDate: string): Promise<ServiceResult<ManagerOverrideRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_manager_overrides", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { audit_log_id: string; actor_name: string; subject_name: string; action: string; description: string; reason: string; created_at: string }) => ({
          auditLogId: row.audit_log_id,
          actorName: row.actor_name,
          subjectName: row.subject_name,
          action: row.action,
          description: row.description,
          reason: row.reason,
          createdAt: row.created_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }

  async locationViolations(startDate: string, endDate: string): Promise<ServiceResult<LocationViolationRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_report_location_violations", { p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { flag_id: string; user_full_name: string; site_name: string; implied_speed_kmh: number; distance_meters: number; occurred_at: string }) => ({
          flagId: row.flag_id,
          userFullName: row.user_full_name,
          siteName: row.site_name,
          impliedSpeedKmh: row.implied_speed_kmh,
          distanceMeters: row.distance_meters,
          occurredAt: row.occurred_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Reports service unavailable.");
    }
  }
}

export default new ReportRepository();
