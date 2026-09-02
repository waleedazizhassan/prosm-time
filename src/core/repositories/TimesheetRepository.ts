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
  clockInEvidencePath: string | null;
  clockOutEvidencePath: string | null;
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

export interface EvidencePackException {
  id: string;
  distanceMeters: number;
  reasonCategory: string | null;
  employeeReason: string | null;
  status: string;
  createdAt: string;
}

export interface EvidencePackCorrection {
  id: string;
  proposedEventType: string;
  proposedCorrectTime: string;
  reason: string;
  status: string;
  createdAt: string;
}

export interface EvidencePackEvidenceReference {
  id: string;
  attendanceEventId: string;
  storagePath: string;
  contentType: string;
  capturedAt: string;
}

export interface EvidencePackApprovalTrailRow {
  action: string;
  actorName: string;
  notes: string | null;
  createdAt: string;
}

export interface EvidencePackTimesheetCorrection {
  id: string;
  reason: string;
  status: string;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface EvidencePack {
  timesheet: {
    id: string;
    periodStart: string;
    periodEnd: string;
    status: TimesheetStatus;
    totalWorkedMinutes: number;
    totalBreakMinutes: number;
    totalOvertimeMinutes: number;
    submittedAt: string | null;
    approvedAt: string | null;
    lockedAt: string | null;
    approverName: string | null;
  };
  employee: { id: string; fullName: string; email: string };
  organization: { id: string; name: string; organizationCode: string };
  entries: TimesheetEntry[];
  exceptions: EvidencePackException[];
  corrections: EvidencePackCorrection[];
  evidenceReferences: EvidencePackEvidenceReference[];
  approvalTrail: EvidencePackApprovalTrailRow[];
  timesheetCorrections: EvidencePackTimesheetCorrection[];
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

  // § live UX review, user-directed - "the clock-in/clock-out photo
  // should be viewable next to its time" applies here too, not only in
  // Manager Console's own attendance table (§ ManagerRepository's own
  // identical join). list_prosm_time_timesheet_entries doesn't carry
  // evidence, so this does the same client-side attendance_events ->
  // camera_evidence join per session, storage paths only (no eager
  // download - EvidenceRepository downloads on demand).
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

      const sessionIds = rows.map((row) => row.sessionId);
      const clockInEvidenceBySession = new Map<string, string>();
      const clockOutEvidenceBySession = new Map<string, string>();

      if (sessionIds.length > 0) {
        const eventsResult = await this.client.from("attendance_events").select("id, session_id, event_type").in("session_id", sessionIds).in("event_type", ["clock_in", "clock_out"]);
        if (!eventsResult.error) {
          const events = (eventsResult.data ?? []) as Array<{ id: string; session_id: string; event_type: "clock_in" | "clock_out" }>;
          const eventIds = events.map((event) => event.id);

          const evidenceByEvent = new Map<string, string>();
          if (eventIds.length > 0) {
            const evidenceResult = await this.client.from("camera_evidence").select("attendance_event_id, storage_path").in("attendance_event_id", eventIds).order("captured_at", { ascending: true });
            if (!evidenceResult.error) {
              for (const evidenceRow of (evidenceResult.data ?? []) as Array<{ attendance_event_id: string; storage_path: string }>) {
                if (!evidenceByEvent.has(evidenceRow.attendance_event_id)) evidenceByEvent.set(evidenceRow.attendance_event_id, evidenceRow.storage_path);
              }
            }
          }

          for (const event of events) {
            const storagePath = evidenceByEvent.get(event.id);
            if (!storagePath) continue;
            if (event.event_type === "clock_in") clockInEvidenceBySession.set(event.session_id, storagePath);
            else clockOutEvidenceBySession.set(event.session_id, storagePath);
          }
        }
      }

      return createSuccess(
        rows.map((row) => ({
          ...row,
          clockInEvidencePath: clockInEvidenceBySession.get(row.sessionId) ?? null,
          clockOutEvidencePath: clockOutEvidenceBySession.get(row.sessionId) ?? null,
        }))
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Timesheet service unavailable.");
    }
  }

  async getEvidencePack(timesheetId: string): Promise<ServiceResult<EvidencePack>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_timesheet_evidence_pack", { p_timesheet_id: timesheetId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to load this report.");
      const { success: _success, ...pack } = data as EvidencePack & { success: boolean };
      return createSuccess(pack as EvidencePack);
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
