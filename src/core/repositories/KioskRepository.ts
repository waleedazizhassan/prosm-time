import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface KioskRosterEntry {
  userId: string;
  fullName: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time WP-18/§13.1 - "Kiosk Mode." Identity at the shared device
// is established by each employee's own PIN (verified server-side),
// never by the operator's own session - see the RPCs' own header
// comments in the WP-18 migration for the full reasoning.
class KioskRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getRoster(siteId: string): Promise<ServiceResult<KioskRosterEntry[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_kiosk_roster", { p_site_id: siteId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to load the kiosk roster.");
      return createSuccess((data?.roster ?? []) as KioskRosterEntry[]);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }

  async kioskClockIn(siteId: string, employeeUserId: string, pin: string, projectId?: string | null): Promise<ServiceResult<{ sessionId: string; eventId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("kiosk-clock-in", {
        body: { siteId, employeeUserId, pin, projectId: projectId ?? null, idempotencyKey: crypto.randomUUID(), clientReportedAt: new Date().toISOString() },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock in.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to clock in.");
      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }

  async kioskClockOut(siteId: string, employeeUserId: string, pin: string): Promise<ServiceResult<{ sessionId: string; eventId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("kiosk-clock-out", {
        body: { siteId, employeeUserId, pin, idempotencyKey: crypto.randomUUID(), clientReportedAt: new Date().toISOString() },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock out.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to clock out.");
      return createSuccess({ sessionId: data.data.sessionId, eventId: data.data.eventId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }

  async setMyPin(pin: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("set-kiosk-pin", { body: { pin } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to set this PIN.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to set this PIN.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }

  async adminSetPin(userId: string, pin: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("admin-set-kiosk-pin", { body: { userId, pin } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to set this employee's PIN.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to set this employee's PIN.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }
}

export default new KioskRepository();
