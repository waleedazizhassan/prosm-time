import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
  // WP-15/§25 - set only on a genuine connectivity failure (the Edge
  // Function was never reached at all), never on a real server
  // rejection, so the offline queue knows when it is safe to queue-
  // and-retry versus surface a real error to the employee.
  networkError?: boolean;
}

export interface AttendanceSession {
  id: string;
  siteId: string;
  projectId: string | null;
  status: "clocked_in" | "clocked_out";
  clockInAt: string;
  clockOutAt: string | null;
  // § live UX review, user-directed - the clock-out confirmation
  // screen needs the workplace name for a no-site session too, not
  // just an assigned site's own name.
  manualLocationLabel: string | null;
}

export interface ClockInInput {
  // § live UX review, user-directed - site is optional: an employee
  // can clock in at their real current location even when it isn't a
  // registered site. WP-06's own clock_in_prosm_time_attendance now
  // accepts a null site and skips site assignment/geofence/presence
  // logic entirely in that case - see the migration's own header for
  // the full reasoning.
  siteId?: string | null;
  projectId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  // § live UX review, user-directed - required whenever siteId is
  // empty: a free-text description of where the employee actually is
  // ("workplace"), so a no-site clock-in never leaves the site column
  // blank in reports. The Edge Function/RPC both re-check this is
  // non-empty when siteId is empty - this is never trusted as-is.
  manualLocationLabel?: string | null;
  // § live UX review, user-directed - a new confirmation screen shown
  // right before every clock-in/out submits offers these two optional
  // free-text fields, stored per-event (attendance_events.note/
  // activity) and shown to managers in the Attendance Record.
  note?: string | null;
  activity?: string | null;
  // WP-15 - an offline-queued replay passes its own already-generated
  // idempotency key and the ORIGINAL client-captured time (§35:
  // "client-captured timestamps are preserved for offline
  // transparency") instead of a fresh one per call.
  idempotencyKey?: string;
  clientReportedAt?: string;
}

export interface ClockOutInput {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  note?: string | null;
  activity?: string | null;
  idempotencyKey?: string;
  clientReportedAt?: string;
}

export interface AdminClockInInput {
  subjectUserId: string;
  siteId: string;
  reason: string;
  projectId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
}

export interface AdminClockOutInput {
  subjectUserId: string;
  reason: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface AttendanceSessionRow {
  id: string;
  site_id: string;
  project_id: string | null;
  status: "clocked_in" | "clocked_out";
  clock_in_at: string;
  clock_out_at: string | null;
  manual_location_label: string | null;
}

function mapSessionRow(row: AttendanceSessionRow): AttendanceSession {
  return {
    id: row.id,
    siteId: row.site_id,
    projectId: row.project_id,
    status: row.status,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    manualLocationLabel: row.manual_location_label,
  };
}

// PROSM Time WP-06/§17 - real Clock In/Out over the clock-in/clock-out
// Edge Functions (§35), never a direct table write - server validation
// (site/project assignment, one open session at a time, idempotent
// replay) all happens there. A fresh idempotency key is generated per
// user action; the same key is safe to retry on a network failure.
class AttendanceRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCurrentSession(userId: string): Promise<ServiceResult<AttendanceSession | null>> {
    try {
      const { data, error } = await this.client.from("attendance_sessions").select("*").eq("user_id", userId).eq("status", "clocked_in").maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? mapSessionRow(data) : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // § live UX review, user-directed - "the confirm-clock-in step should
  // show the last clock-out time" (reference-app inspiration for
  // information hierarchy only). Purely a display read - never fed back
  // into any submit path.
  async getLastCompletedSession(userId: string): Promise<ServiceResult<AttendanceSession | null>> {
    try {
      const { data, error } = await this.client
        .from("attendance_sessions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "clocked_out")
        .order("clock_out_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? mapSessionRow(data) : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async clockIn(input: ClockInInput): Promise<ServiceResult<{ sessionId: string; eventId: string; presenceSessionId: string | null }>> {
    try {
      const { data, error } = await this.client.functions.invoke("clock-in", {
        body: {
          siteId: input.siteId,
          projectId: input.projectId ?? null,
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          clientReportedAt: input.clientReportedAt ?? new Date().toISOString(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
          manualLocationLabel: input.manualLocationLabel ?? null,
          note: input.note ?? null,
          activity: input.activity ?? null,
        },
      });

      if (error) {
        if (error.name === "FunctionsFetchError") {
          return { success: false, message: null, data: null, networkError: true };
        }
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock in.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to clock in.");
      }

      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId, presenceSessionId: data.data.presenceSessionId ?? null });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async clockOut(input: ClockOutInput): Promise<ServiceResult<{ sessionId: string; eventId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("clock-out", {
        body: {
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          clientReportedAt: input.clientReportedAt ?? new Date().toISOString(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
          note: input.note ?? null,
          activity: input.activity ?? null,
        },
      });

      if (error) {
        if (error.name === "FunctionsFetchError") {
          return { success: false, message: null, data: null, networkError: true };
        }
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock out.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to clock out.");
      }

      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // WP-07/§10 - "An authorized administrator may perform Clock In...
  // on behalf of an employee." A distinct, separately-permissioned
  // action (never a variant of the employee's own clockIn/clockOut
  // above) - admin-clock-in/admin-clock-out re-check
  // 'attendance.clock_in_on_behalf'/'attendance.clock_out_on_behalf'
  // server-side and record the caller as ACTOR, the target as SUBJECT.
  async adminClockIn(input: AdminClockInInput): Promise<ServiceResult<{ sessionId: string; eventId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("admin-clock-in", {
        body: {
          subjectUserId: input.subjectUserId,
          siteId: input.siteId,
          reason: input.reason,
          projectId: input.projectId ?? null,
          idempotencyKey: crypto.randomUUID(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
        },
      });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock in this employee.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to clock in this employee.");
      }

      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async adminClockOut(input: AdminClockOutInput): Promise<ServiceResult<{ sessionId: string; eventId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("admin-clock-out", {
        body: {
          subjectUserId: input.subjectUserId,
          reason: input.reason,
          idempotencyKey: crypto.randomUUID(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
        },
      });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock out this employee.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to clock out this employee.");
      }

      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async getActiveBreak(attendanceSessionId: string): Promise<ServiceResult<{ id: string; startedAt: string } | null>> {
    try {
      const { data, error } = await this.client.from("break_events").select("id, started_at").eq("attendance_session_id", attendanceSessionId).eq("status", "active").maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? { id: data.id, startedAt: data.started_at } : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // § live UX review, user-directed - "the break button doesn't pause
  // the elapsed-time counter, it just keeps counting" - the counter
  // needs the total of every ALREADY-ENDED break this session to
  // subtract from wall-clock elapsed time (the currently active break,
  // if any, contributes nothing further while it's still running -
  // ClockInOutCard freezes the display at its own startedAt instead).
  async getCompletedBreakSeconds(attendanceSessionId: string): Promise<ServiceResult<number>> {
    try {
      const { data, error } = await this.client.from("break_events").select("started_at, ended_at").eq("attendance_session_id", attendanceSessionId).eq("status", "ended");
      if (error) return createError(error.message);
      const totalSeconds = (data ?? []).reduce((sum: number, row: { started_at: string; ended_at: string | null }) => {
        if (!row.ended_at) return sum;
        return sum + Math.max(0, (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000);
      }, 0);
      return createSuccess(totalSeconds);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // § live UX review, user-directed - a real clock-out summary (worked/
  // break/overtime minutes, whether the employee left before the
  // site's own shift_end_time) shown right after a successful Clock
  // Out. Mirrors generate_prosm_time_timesheet's own overtime formula
  // (20260902130000) applied to this one session, not a full pay
  // period - an at-a-glance figure, not the authoritative payroll one.
  async getSessionSummary(attendanceSessionId: string): Promise<
    ServiceResult<{
      workedMinutes: number;
      breakMinutes: number;
      overtimeMinutes: number;
      exceptionsCount: number;
      leftEarly: boolean;
      earlyMinutes: number;
      shiftEndTime: string | null;
      earlyLeaveReason: string | null;
    }>
  > {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_session_summary", { p_attendance_session_id: attendanceSessionId });
      if (error) return createError(error.message);
      return createSuccess({
        workedMinutes: Number(data?.workedMinutes ?? 0),
        breakMinutes: Number(data?.breakMinutes ?? 0),
        overtimeMinutes: Number(data?.overtimeMinutes ?? 0),
        exceptionsCount: Number(data?.exceptionsCount ?? 0),
        leftEarly: data?.leftEarly === true,
        earlyMinutes: Number(data?.earlyMinutes ?? 0),
        shiftEndTime: data?.shiftEndTime ?? null,
        earlyLeaveReason: data?.earlyLeaveReason ?? null,
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async submitEarlyLeaveReason(attendanceSessionId: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("submit_prosm_time_early_leave_reason", { p_attendance_session_id: attendanceSessionId, p_reason: reason });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to submit this reason.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // WP-12/§17.1 - break start/end, real Edge Functions per §35.
  async startBreak(attendanceSessionId: string): Promise<ServiceResult<{ breakId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("start-break", {
        body: { attendanceSessionId, idempotencyKey: crypto.randomUUID() },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to start a break.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to start a break.");
      return createSuccess({ breakId: data.data.breakId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async endBreak(breakId: string): Promise<ServiceResult<{ maxDurationExceeded: boolean }>> {
    try {
      const { data, error } = await this.client.functions.invoke("end-break", { body: { breakId } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to end this break.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to end this break.");
      return createSuccess({ maxDurationExceeded: Boolean(data.data.maxDurationExceeded) });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // § live UX review, user-directed - mid-shift "Change Site": ends the
  // active break, moves the still-open session to the new site, never
  // clocks the employee out. Same Edge Function shape as start-break/
  // end-break (§35 - a real session mutation, not a direct table write).
  async changeSite(
    breakId: string | null,
    newSiteId: string | null,
    latitude: number | null,
    longitude: number | null,
    accuracyMeters: number | null,
    manualLocationLabel?: string | null,
  ): Promise<ServiceResult<{ siteChangeId: string; maxDurationExceeded: boolean }>> {
    try {
      const { data, error } = await this.client.functions.invoke("change-site", {
        body: { breakId, newSiteId, latitude, longitude, accuracyMeters, manualLocationLabel: manualLocationLabel ?? null },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to change site.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to change site.");
      return createSuccess({ siteChangeId: data.data.siteChangeId, maxDurationExceeded: Boolean(data.data.maxDurationExceeded) });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // § user-directed - Dashboard KPI audit: a real-time "on break now"
  // count. break_events' own RLS (subject OR org-wide attendance.view
  // holder) is exactly what already scopes every other KPI on this
  // dashboard - a plain direct select, no new RPC needed.
  async listOnBreakNow(): Promise<ServiceResult<{ id: string; userId: string; userFullName: string; startedAt: string }[]>> {
    interface RawBreakRow {
      id: string;
      user_id: string;
      started_at: string;
      users: { full_name: string } | { full_name: string }[] | null;
    }
    try {
      const { data, error } = await this.client.from("break_events").select("id, user_id, started_at, users(full_name)").eq("status", "active").order("started_at", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as RawBreakRow[]).map((row) => {
          const user = Array.isArray(row.users) ? row.users[0] : row.users;
          return { id: row.id, userId: row.user_id, userFullName: user?.full_name ?? "", startedAt: row.started_at };
        }),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }
}

export default new AttendanceRepository();
