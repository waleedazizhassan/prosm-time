import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface PresenceSession {
  id: string;
  attendanceSessionId: string;
  status: "active" | "ended";
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface PresenceSessionRow {
  id: string;
  attendance_session_id: string;
  status: "active" | "ended";
}

function mapRow(row: PresenceSessionRow): PresenceSession {
  return { id: row.id, attendanceSessionId: row.attendance_session_id, status: row.status };
}

// PROSM Time WP-10/§18 - "Active presence sessions, controlled
// location sampling, SOS action." A presence session only exists when
// the site's own presence_monitoring_enabled policy was on at Clock
// In (WP-06's own RPC creates it) - getActiveSession simply re-derives
// current state from the database, matching how AttendanceRepository.
// getCurrentSession already works. record_prosm_time_presence_sample
// is a direct RPC (§35 does not name presence sampling among its
// Edge-Function-mediated flows); SOS goes through the real
// trigger-sos-alert Edge Function, which §35 explicitly requires.
class PresenceRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getActiveSession(userId: string): Promise<ServiceResult<PresenceSession | null>> {
    try {
      const { data, error } = await this.client.from("presence_sessions").select("*").eq("user_id", userId).eq("status", "active").maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? mapRow(data) : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Presence service unavailable.");
    }
  }

  async recordSample(presenceSessionId: string, latitude: number, longitude: number, accuracyMeters: number | null): Promise<ServiceResult<{ exceptionCreated: boolean }>> {
    try {
      const { data, error } = await this.client.rpc("record_prosm_time_presence_sample", {
        p_presence_session_id: presenceSessionId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_accuracy_meters: accuracyMeters,
        p_client_reported_at: new Date().toISOString(),
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to record this location sample.");
      return createSuccess({ exceptionCreated: data?.exceptionCreated === true });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Presence service unavailable.");
    }
  }

  async triggerSos(presenceSessionId: string, latitude: number | null, longitude: number | null, accuracyMeters: number | null): Promise<ServiceResult<{ alertId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("trigger-sos-alert", {
        body: { presenceSessionId, latitude, longitude, accuracyMeters },
      });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to trigger an SOS alert.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to trigger an SOS alert.");
      }

      return createSuccess({ alertId: data.data.alertId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Presence service unavailable.");
    }
  }
}

export default new PresenceRepository();
