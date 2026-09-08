import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
  code?: string | null;
}

export interface QuickBooksStatus {
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

// PROSM Time - the 3rd and final competitive gap this session's own
// research surfaced: real payroll-system integration (QuickBooks
// Online / Intuit, OAuth2). Connect/disconnect/status all go through
// RPCs (quickbooks_connections itself grants nothing to authenticated
// at all - tokens must never reach the client); starting a connection
// and running a sync go through Edge Functions because they need to
// call out to Intuit's own OAuth/API endpoints with this org's stored
// secret, which no client-side call could ever hold.
class QuickBooksRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getStatus(): Promise<ServiceResult<QuickBooksStatus>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_quickbooks_status");
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
      return createError(error instanceof Error ? error.message : "QuickBooks service unavailable.");
    }
  }

  async startConnection(): Promise<ServiceResult<{ authorizeUrl: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("quickbooks-authorize", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to start the QuickBooks connection.", errorBody?.error?.code ?? null);
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to start the QuickBooks connection.", data?.error?.code ?? null);
      return createSuccess({ authorizeUrl: data.data.authorizeUrl });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "QuickBooks service unavailable.");
    }
  }

  async disconnect(): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("disconnect_prosm_time_quickbooks");
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to disconnect QuickBooks.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "QuickBooks service unavailable.");
    }
  }

  async syncNow(): Promise<ServiceResult<{ synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[] }>> {
    try {
      const { data, error } = await this.client.functions.invoke("sync-quickbooks-time-activity", { body: {} });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to sync with QuickBooks.");
      }
      if (!data?.success) return createError(data?.error?.message ?? "Unable to sync with QuickBooks.");
      return createSuccess(data.data);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "QuickBooks service unavailable.");
    }
  }
}

export default new QuickBooksRepository();
