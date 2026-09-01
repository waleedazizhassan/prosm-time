import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Timesheet {
  id: string;
  userId: string;
  userFullName: string;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  totalWorkedMinutes: number;
  totalBreakMinutes: number;
  totalOvertimeMinutes: number;
  exceptionsCount: number;
  correctionsCount: number;
  submittedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
}

export interface TimesheetEntry {
  sessionId: string;
  siteId: string | null;
  siteName: string | null;
  projectId: string | null;
  projectName: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
}

export interface TimesheetCorrection {
  id: string;
  timesheetId: string;
  userFullName: string;
  periodStart: string;
  periodEnd: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface RawUserRef {
  full_name: string | null;
}

interface TimesheetRow {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  status: TimesheetStatus;
  total_worked_minutes: number;
  total_break_minutes: number;
  total_overtime_minutes: number;
  exceptions_count: number;
  corrections_count: number;
  submitted_at: string | null;
  approved_at: string | null;
  locked_at: string | null;
  users: RawUserRef | RawUserRef[] | null;
}

function mapTimesheetRow(row: TimesheetRow): Timesheet {
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  return {
    id: row.id,
    userId: row.user_id,
    userFullName: user?.full_name ?? "",
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    totalWorkedMinutes: row.total_worked_minutes,
    totalBreakMinutes: row.total_break_minutes,
    totalOvertimeMinutes: row.total_overtime_minutes,
    exceptionsCount: row.exceptions_count,
    correctionsCount: row.corrections_count,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    lockedAt: row.locked_at,
  };
}

interface TimesheetCorrectionRow {
  id: string;
  timesheet_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  timesheets: { period_start: string; period_end: string; users: RawUserRef | RawUserRef[] | null } | { period_start: string; period_end: string; users: RawUserRef | RawUserRef[] | null }[] | null;
}

function mapCorrectionRow(row: TimesheetCorrectionRow): TimesheetCorrection {
  const timesheet = Array.isArray(row.timesheets) ? row.timesheets[0] : row.timesheets;
  const user = timesheet ? (Array.isArray(timesheet.users) ? timesheet.users[0] : timesheet.users) : null;
  return {
    id: row.id,
    timesheetId: row.timesheet_id,
    userFullName: user?.full_name ?? "",
    periodStart: timesheet?.period_start ?? "",
    periodEnd: timesheet?.period_end ?? "",
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

// PROSM Time WP-16/§22 - "Timesheet & Monthly Evidence Pack." Reads
// go straight to the postgrest-exposed tables (RLS already scopes
// self-or-timesheet-permission-holder, same pattern as every other
// read-only repository in this app); every write is a real Edge
// Function per §35, re-checked server-side.
class TimesheetRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listMyTimesheets(userId: string): Promise<ServiceResult<Timesheet[]>> {
    try {
      const { data, error } = await this.client
        .from("timesheets")
        .select("id, user_id, period_start, period_end, status, total_worked_minutes, total_break_minutes, total_overtime_minutes, exceptions_count, corrections_count, submitted_at, approved_at, locked_at, users(full_name)")
        .eq("user_id", userId)
        .order("period_start", { ascending: false });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapTimesheetRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async listPendingApprovals(): Promise<ServiceResult<Timesheet[]>> {
    try {
      const { data, error } = await this.client
        .from("timesheets")
        .select("id, user_id, period_start, period_end, status, total_worked_minutes, total_break_minutes, total_overtime_minutes, exceptions_count, corrections_count, submitted_at, approved_at, locked_at, users(full_name)")
        .eq("status", "submitted")
        .order("submitted_at", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapTimesheetRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async listPendingCorrections(): Promise<ServiceResult<TimesheetCorrection[]>> {
    try {
      const { data, error } = await this.client
        .from("timesheet_corrections")
        .select("id, timesheet_id, reason, status, created_at, timesheets(period_start, period_end, users(full_name))")
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapCorrectionRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async getEntries(timesheetId: string): Promise<ServiceResult<TimesheetEntry[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_timesheet_entries", { p_timesheet_id: timesheetId });
      if (error) return createError(error.message);
      const rows = (data?.entries ?? []) as Array<{
        sessionId: string;
        siteId: string | null;
        siteName: string | null;
        projectId: string | null;
        projectName: string | null;
        clockInAt: string;
        clockOutAt: string | null;
        workedMinutes: number;
        breakMinutes: number;
      }>;
      return createSuccess(rows);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async generateTimesheet(userId: string, periodStart: string, periodEnd: string): Promise<ServiceResult<{ timesheetId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("generate-timesheet", { body: { userId, periodStart, periodEnd } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to generate this timesheet.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to generate this timesheet.");
      return createSuccess({ timesheetId: data.data.timesheetId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async submitTimesheet(timesheetId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("submit-timesheet", { body: { timesheetId } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to submit this timesheet.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to submit this timesheet.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async approveTimesheet(timesheetId: string, action: "approved" | "rejected", notes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("approve-timesheet", { body: { timesheetId, action, notes: notes ?? null } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to review this timesheet.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to review this timesheet.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async requestCorrection(timesheetId: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("request-timesheet-correction", { body: { timesheetId, reason } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to request this correction.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to request this correction.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async reviewCorrection(correctionId: string, action: "approved" | "rejected", notes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("review-timesheet-correction", { body: { correctionId, action, notes: notes ?? null } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to review this correction.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to review this correction.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }
}

export default new TimesheetRepository();
