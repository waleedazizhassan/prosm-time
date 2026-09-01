import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface AttendanceSession {
  id: string;
  siteId: string;
  projectId: string | null;
  status: "clocked_in" | "clocked_out";
  clockInAt: string;
  clockOutAt: string | null;
}

export interface ClockInInput {
  siteId: string;
  projectId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
}

export interface ClockOutInput {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
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
}

function mapSessionRow(row: AttendanceSessionRow): AttendanceSession {
  return {
    id: row.id,
    siteId: row.site_id,
    projectId: row.project_id,
    status: row.status,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
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

  async clockIn(input: ClockInInput): Promise<ServiceResult<{ sessionId: string; eventId: string; presenceSessionId: string | null }>> {
    try {
      const { data, error } = await this.client.functions.invoke("clock-in", {
        body: {
          siteId: input.siteId,
          projectId: input.projectId ?? null,
          idempotencyKey: crypto.randomUUID(),
          clientReportedAt: new Date().toISOString(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
        },
      });

      if (error) {
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
          idempotencyKey: crypto.randomUUID(),
          clientReportedAt: new Date().toISOString(),
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
        },
      });

      if (error) {
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

  async getActiveBreak(attendanceSessionId: string): Promise<ServiceResult<{ id: string } | null>> {
    try {
      const { data, error } = await this.client.from("break_events").select("id").eq("attendance_session_id", attendanceSessionId).eq("status", "active").maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? { id: data.id } : null);
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
}

export default new AttendanceRepository();
