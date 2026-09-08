import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
  code?: string | null;
}

export interface GustoStatus {
  connected: boolean;
  companyName: string | null;
  enabled: boolean;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncSummary: { synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[]; ranAt: string } | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string, code: string | null = null): ServiceResult<T> {
  return { success: false, message, data: null, code };
}

// PROSM Time - Gusto payroll integration, mirrors QuickBooksRepository.ts
// exactly. One of 3 providers offered from the unified Settings >
// Payroll Integration selector (PayrollIntegrationCard.tsx). See
// sync-gusto-hours/index.ts's own header comment - Gusto's real sync
// mechanics are the least certain of the three providers built this
// session (requires an open payroll run, unlike QuickBooks/Xero).
class GustoRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getStatus(): Promise<ServiceResult<GustoStatus>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_gusto_status");
      if (error) return createError(error.message);
      return createSuccess({
        connected: data.connected === true,
        companyName: data.companyName ?? null,
        enabled: data.enabled === true,
        connectedAt: data.connectedAt ?? null,
        lastSyncedAt: data.lastSyncedAt ?? null,
        lastSyncSummary: data.lastSyncSummary ?? null,
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Gusto service unavailable.");
    }
  }

  async startConnection(): Promise<ServiceResult<{ authorizeUrl: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("gusto-authorize", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to start the Gusto connection.", errorBody?.error?.code ?? null);
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to start the Gusto connection.", data?.error?.code ?? null);
      return createSuccess({ authorizeUrl: data.data.authorizeUrl });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Gusto service unavailable.");
    }
  }

  async disconnect(): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("disconnect_prosm_time_gusto");
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to disconnect Gusto.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Gusto service unavailable.");
    }
  }

  async syncNow(): Promise<ServiceResult<{ synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[] }>> {
    try {
      const { data, error } = await this.client.functions.invoke("sync-gusto-hours", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to sync with Gusto.", errorBody?.error?.code ?? null);
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to sync with Gusto.", data?.error?.code ?? null);
      return createSuccess(data.data);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Gusto service unavailable.");
    }
  }
}

export default new GustoRepository();
