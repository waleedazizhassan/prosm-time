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

  async recordSample(
    presenceSessionId: string,
    latitude: number,
    longitude: number,
    accuracyMeters: number | null,
  ): Promise<ServiceResult<{ exceptionCreated: boolean; exitPrompted: boolean; autoCheckout: boolean }>> {
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
      // v2.3.43 step 12 (item 24): the server says when the person has just left the site (or was clocked out for it).
      return createSuccess({ exceptionCreated: data?.exceptionCreated === true, exitPrompted: data?.exit?.prompted === true, autoCheckout: data?.exit?.autoCheckout === true });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Presence service unavailable.");
    }
  }

  // v2.3.43 step 12: the open "you left the site" question, if any.
  async pendingExitPrompt(userId: string): Promise<boolean> {
    try {
      const { data } = await this.client
        .from("presence_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "active")
        .not("exit_prompted_at", "is", null)
        .is("exit_dismissed_at", null)
        .limit(1);
      return (data ?? []).length > 0;
    } catch {
      return false;
    }
  }

  async answerExitPrompt(): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("respond_prosm_time_site_exit", { p_action: "still_working" });
      return error ? createError(error.message) : createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Presence service unavailable.");
    }
  }

  // SOS on every shift (owner 2026-10-13): raised from the clocked-in
  // shift itself; the presence session id (when monitoring is on) is
  // sent too so an older trigger-sos-alert deployment still accepts it.
  async triggerSos(
    sessions: { attendanceSessionId: string; presenceSessionId: string | null },
    latitude: number | null,
    longitude: number | null,
    accuracyMeters: number | null,
  ): Promise<ServiceResult<{ alertId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("trigger-sos-alert", {
        body: { attendanceSessionId: sessions.attendanceSessionId, presenceSessionId: sessions.presenceSessionId, latitude, longitude, accuracyMeters },
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
