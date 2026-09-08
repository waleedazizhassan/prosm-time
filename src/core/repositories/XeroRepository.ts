import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
  code?: string | null;
}

export interface XeroStatus {
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

// PROSM Time - Xero payroll integration, mirrors QuickBooksRepository.ts
// exactly (see that file's own header comment for the "why RPC vs Edge
// Function" split). One of 3 providers offered from the unified
// Settings > Payroll Integration selector (PayrollIntegrationCard.tsx).
class XeroRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getStatus(): Promise<ServiceResult<XeroStatus>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_xero_status");
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
      return createError(error instanceof Error ? error.message : "Xero service unavailable.");
    }
  }

  async startConnection(): Promise<ServiceResult<{ authorizeUrl: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("xero-authorize", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to start the Xero connection.", errorBody?.error?.code ?? null);
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to start the Xero connection.", data?.error?.code ?? null);
      return createSuccess({ authorizeUrl: data.data.authorizeUrl });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Xero service unavailable.");
    }
  }

  async disconnect(): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("disconnect_prosm_time_xero");
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to disconnect Xero.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Xero service unavailable.");
    }
  }

  async syncNow(): Promise<ServiceResult<{ synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[] }>> {
    try {
      const { data, error } = await this.client.functions.invoke("sync-xero-timesheets", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to sync with Xero.", errorBody?.error?.code ?? null);
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to sync with Xero.", data?.error?.code ?? null);
      return createSuccess(data.data);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Xero service unavailable.");
    }
  }
}

export default new XeroRepository();
