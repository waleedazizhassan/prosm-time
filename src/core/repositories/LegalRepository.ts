import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
  networkError?: boolean;
}

// Privacy Policy / Terms of Use acknowledgement (owner 2026-10-13),
// recorded on the server with the version and time.
class LegalRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async hasAcknowledged(userId: string, version: string): Promise<ServiceResult<boolean>> {
    try {
      const { data, error } = await this.client.from("legal_acknowledgements").select("id").eq("user_id", userId).eq("version", version).limit(1);
      if (error) return { success: false, message: error.message, data: null };
      return { success: true, message: null, data: (data ?? []).length > 0 };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Unavailable.", data: null, networkError: true };
    }
  }

  async acknowledge(version: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("acknowledge_prosm_time_legal", { p_version: version });
      if (error) return { success: false, message: error.message, data: null };
      if (data?.success === false) return { success: false, message: "Unable to save.", data: null };
      return { success: true, message: null, data: null };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Unavailable.", data: null, networkError: true };
    }
  }
}

export default new LegalRepository();
