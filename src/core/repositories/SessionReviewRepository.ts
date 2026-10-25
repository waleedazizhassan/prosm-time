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

// v2.3.43 step 2 (item 11): a shift closed automatically after the
// organisation's limit; its hours count nowhere until a manager sets its end.
export interface PendingSessionRow {
  sessionId: string;
  userId: string;
  employeeName: string;
  avatarUrl: string | null;
  siteId: string | null;
  siteName: string | null;
  clockInAt: string;
  clockOutAt: string;
  autoClosedAt: string | null;
  lastActivityAt: string | null;
}

// Shifts opened before the automatic close existed and still open past the limit.
export interface StaleOpenSessionRow {
  sessionId: string;
  userId: string;
  employeeName: string;
  siteName: string | null;
  clockInAt: string;
  openHours: number;
}

interface PendingSessionDbRow {
  session_id: string;
  user_id: string;
  employee_name: string;
  avatar_url: string | null;
  site_id: string | null;
  site_name: string | null;
  clock_in_at: string;
  clock_out_at: string;
  auto_closed_at: string | null;
  last_activity_at: string | null;
}

interface StaleOpenSessionDbRow {
  session_id: string;
  user_id: string;
  employee_name: string;
  site_name: string | null;
  clock_in_at: string;
  open_hours: number;
}

class SessionReviewRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listPending(): Promise<ServiceResult<PendingSessionRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_pending_sessions");
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as PendingSessionDbRow[]).map((row) => ({
          sessionId: row.session_id,
          userId: row.user_id,
          employeeName: row.employee_name,
          avatarUrl: row.avatar_url,
          siteId: row.site_id,
          siteName: row.site_name,
          clockInAt: row.clock_in_at,
          clockOutAt: row.clock_out_at,
          autoClosedAt: row.auto_closed_at,
          lastActivityAt: row.last_activity_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async listStaleOpen(): Promise<ServiceResult<StaleOpenSessionRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_stale_open_sessions");
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as StaleOpenSessionDbRow[]).map((row) => ({
          sessionId: row.session_id,
          userId: row.user_id,
          employeeName: row.employee_name,
          siteName: row.site_name,
          clockInAt: row.clock_in_at,
          openHours: Number(row.open_hours),
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async review(sessionId: string, clockOutAt: string, reason: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("review_prosm_time_pending_session", { p_session_id: sessionId, p_clock_out_at: clockOutAt, p_reason: reason });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  async extend(sessionId: string, until: string, reason: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("extend_prosm_time_session", { p_session_id: sessionId, p_until: until, p_reason: reason });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // The employee: "still working" after the long-shift question.
  async stillWorking(): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("respond_prosm_time_long_session", { p_action: "still_working" });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  // The app was opened during a shift: the last known activity (the end of an
  // automatically closed shift). Best effort - never surfaces an error.
  async touchActivity(): Promise<void> {
    try {
      await this.client.rpc("touch_prosm_time_session_activity");
    } catch {
      // offline or signed out: nothing to record
    }
  }

  // Discarding an action saved offline leaves a trace on the server (best effort).
  async logOfflineDiscard(kind: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.client.rpc("log_prosm_time_offline_discard", { p_kind: kind, p_detail: detail });
    } catch {
      // offline: the discard itself still happens on the device
    }
  }
}

export default new SessionReviewRepository();
