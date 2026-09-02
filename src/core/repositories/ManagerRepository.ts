import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface TodayAttendanceRow {
  sessionId: string;
  userId: string;
  userFullName: string;
  siteName: string;
  status: "clocked_in" | "clocked_out";
  clockInAt: string;
  clockOutAt: string | null;
  hasActivePresence: boolean;
  clockInEvidencePath: string | null;
  clockOutEvidencePath: string | null;
}

export interface PendingReviewItem {
  kind: "geofence_exception" | "correction_request";
  id: string;
  userFullName: string;
  summary: string;
  createdAt: string;
}

interface RawUserRef {
  full_name: string | null;
}

interface RawAttendanceSessionRow {
  id: string;
  user_id: string;
  status: "clocked_in" | "clocked_out";
  clock_in_at: string;
  clock_out_at: string | null;
  manual_location_label: string | null;
  users: RawUserRef | RawUserRef[] | null;
  sites: { name: string | null } | { name: string | null }[] | null;
}

interface RawAttendanceEventRow {
  id: string;
  session_id: string;
  event_type: "clock_in" | "clock_out";
}

interface RawCameraEvidenceRow {
  attendance_event_id: string;
  storage_path: string;
}

interface RawGeofenceExceptionRow {
  id: string;
  distance_meters: number;
  employee_reason: string | null;
  created_at: string;
  users: RawUserRef | RawUserRef[] | null;
}

interface RawCorrectionRequestRow {
  id: string;
  proposed_event_type: string;
  proposed_correct_time: string;
  reason: string;
  created_at: string;
  users: RawUserRef | RawUserRef[] | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time WP-14/§21 - "Operational dashboard... Exceptions and
// approvals." No new RPCs needed - geofence_exceptions/correction_
// requests/attendance_sessions RLS grants each caller exactly what
// they are authorized to see (their own rows always; an org-wide
// read additionally scoped to the caller's own managed sites for
// attendance.view holders, unscoped for the Owner - 20260902090000);
// this repository is purely the aggregation queries Manager Console
// and the Attendance Record screen need, on top of that same RLS.
class ManagerRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  // Shared by listTodayAttendance and listAttendanceHistory - only the
  // clock_in_at range differs between "today" and an arbitrary
  // caller-picked period; the session/presence/evidence joins and row
  // shaping are otherwise identical.
  private async fetchAttendanceRows(fromIso: string, toIso?: string): Promise<ServiceResult<TodayAttendanceRow[]>> {
    try {
      let sessionsQuery = this.client
        .from("attendance_sessions")
        .select("id, user_id, status, clock_in_at, clock_out_at, manual_location_label, users(full_name), sites(name)")
        .gte("clock_in_at", fromIso)
        .order("clock_in_at", { ascending: false });
      if (toIso) sessionsQuery = sessionsQuery.lte("clock_in_at", toIso);

      const [sessionsResult, presenceResult] = await Promise.all([
        sessionsQuery,
        this.client.from("presence_sessions").select("attendance_session_id").eq("status", "active"),
      ]);

      if (sessionsResult.error) return createError(sessionsResult.error.message);

      const activePresenceIds = new Set((presenceResult.data ?? []).map((row: { attendance_session_id: string }) => row.attendance_session_id));

      const sessionIds = ((sessionsResult.data ?? []) as RawAttendanceSessionRow[]).map((row) => row.id);

      // PROSM Time - live UX review: "the photo the employee captures
      // should show next to the clock-in time, and the clock-out photo
      // next to the clock-out time." attendance_events/camera_evidence
      // are only joined for today's sessions (not a global fetch), and
      // storage paths only - no eager download here, EvidenceRepository
      // downloads on demand when the manager opens a thumbnail.
      const clockInEvidenceBySession = new Map<string, string>();
      const clockOutEvidenceBySession = new Map<string, string>();
      if (sessionIds.length > 0) {
        const eventsResult = await this.client.from("attendance_events").select("id, session_id, event_type").in("session_id", sessionIds).in("event_type", ["clock_in", "clock_out"]);
        if (eventsResult.error) return createError(eventsResult.error.message);

        const events = (eventsResult.data ?? []) as RawAttendanceEventRow[];
        const eventIds = events.map((event) => event.id);

        const evidenceByEvent = new Map<string, string>();
        if (eventIds.length > 0) {
          const evidenceResult = await this.client.from("camera_evidence").select("attendance_event_id, storage_path").in("attendance_event_id", eventIds).order("captured_at", { ascending: true });
          if (evidenceResult.error) return createError(evidenceResult.error.message);
          for (const evidenceRow of (evidenceResult.data ?? []) as RawCameraEvidenceRow[]) {
            if (!evidenceByEvent.has(evidenceRow.attendance_event_id)) evidenceByEvent.set(evidenceRow.attendance_event_id, evidenceRow.storage_path);
          }
        }

        for (const event of events) {
          const storagePath = evidenceByEvent.get(event.id);
          if (!storagePath) continue;
          if (event.event_type === "clock_in") clockInEvidenceBySession.set(event.session_id, storagePath);
          else clockOutEvidenceBySession.set(event.session_id, storagePath);
        }
      }

      const rows = ((sessionsResult.data ?? []) as RawAttendanceSessionRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
        return {
          sessionId: row.id,
          userId: row.user_id,
          userFullName: user?.full_name ?? "",
          // § live UX review, user-directed - a no-site clock-in now
          // requires a free-text workplace label instead of leaving
          // this blank (manual_location_label, 20260902120000) - a
          // real site's name always wins when one exists.
          siteName: site?.name ?? row.manual_location_label ?? "",
          status: row.status,
          clockInAt: row.clock_in_at,
          clockOutAt: row.clock_out_at,
          hasActivePresence: activePresenceIds.has(row.id),
          clockInEvidencePath: clockInEvidenceBySession.get(row.id) ?? null,
          clockOutEvidencePath: clockOutEvidenceBySession.get(row.id) ?? null,
        };
      });

      return createSuccess(rows);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  async listTodayAttendance(): Promise<ServiceResult<TodayAttendanceRow[]>> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.fetchAttendanceRows(startOfDay.toISOString());
  }

  // Attendance Record screen - same underlying rows as
  // listTodayAttendance, just over a caller-picked calendar range
  // instead of a hardcoded "today". startDate/endDate are plain
  // "YYYY-MM-DD" strings from a date input; expanded to that day's
  // full local start/end before querying so the end date is inclusive.
  async listAttendanceHistory(startDate: string, endDate: string): Promise<ServiceResult<TodayAttendanceRow[]>> {
    const from = new Date(`${startDate}T00:00:00`);
    const to = new Date(`${endDate}T23:59:59.999`);
    return this.fetchAttendanceRows(from.toISOString(), to.toISOString());
  }

  async listPendingReview(): Promise<ServiceResult<PendingReviewItem[]>> {
    try {
      const [exceptionsResult, correctionsResult] = await Promise.all([
        this.client.from("geofence_exceptions").select("id, distance_meters, employee_reason, created_at, users(full_name)").eq("status", "pending_review"),
        this.client.from("correction_requests").select("id, proposed_event_type, proposed_correct_time, reason, created_at, users(full_name)").eq("status", "pending"),
      ]);

      if (exceptionsResult.error) return createError(exceptionsResult.error.message);
      if (correctionsResult.error) return createError(correctionsResult.error.message);

      const exceptionItems: PendingReviewItem[] = ((exceptionsResult.data ?? []) as RawGeofenceExceptionRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        return {
          kind: "geofence_exception" as const,
          id: row.id,
          userFullName: user?.full_name ?? "",
          summary: `${Math.round(row.distance_meters)} m outside area - ${row.employee_reason ?? ""}`,
          createdAt: row.created_at,
        };
      });

      const correctionItems: PendingReviewItem[] = ((correctionsResult.data ?? []) as RawCorrectionRequestRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        return {
          kind: "correction_request" as const,
          id: row.id,
          userFullName: user?.full_name ?? "",
          summary: `${row.proposed_event_type} -> ${new Date(row.proposed_correct_time).toLocaleString()} - ${row.reason}`,
          createdAt: row.created_at,
        };
      });

      return createSuccess([...exceptionItems, ...correctionItems].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  async reviewItem(kind: "geofence_exception" | "correction_request", targetId: string, actionType: string, notes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("review-exception", {
        body: { kind, targetId, actionType, notes: notes ?? null },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to review this item.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to review this item.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }
}

export default new ManagerRepository();
