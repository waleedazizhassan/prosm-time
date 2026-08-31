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

  async clockIn(input: ClockInInput): Promise<ServiceResult<{ sessionId: string }>> {
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

      return createSuccess({ sessionId: data.data.sessionId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async clockOut(input: ClockOutInput): Promise<ServiceResult<{ sessionId: string }>> {
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

      return createSuccess({ sessionId: data.data.sessionId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }
}

export default new AttendanceRepository();
