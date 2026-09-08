import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function mapRow(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// PROSM Time - § live UX review, user-directed: a real, Owner-only,
// read-only integration key so sibling PROSM products (PROSM Projects
// first) can pull verified attendance instead of hand-typing it
// (export-attendance Edge Function, 20260908190000). The plaintext key
// is only ever returned once, from generate() itself - list() only
// ever returns metadata (name/prefix/timestamps), matching the same
// one-time-display posture as the platform's own product API keys.
class ApiKeyRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async list(): Promise<ServiceResult<ApiKeySummary[]>> {
    try {
      const { data, error } = await this.client.from("api_keys").select("id, name, key_prefix, created_at, last_used_at, revoked_at").order("created_at", { ascending: false });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "API key service unavailable.");
    }
  }

  async generate(name: string): Promise<ServiceResult<{ keyId: string; apiKey: string }>> {
    try {
      const { data, error } = await this.client.rpc("generate_prosm_time_api_key", { p_name: name });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to create this API key.");
      return createSuccess({ keyId: data.keyId, apiKey: data.apiKey });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "API key service unavailable.");
    }
  }

  async revoke(keyId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("revoke_prosm_time_api_key", { p_key_id: keyId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to revoke this API key.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "API key service unavailable.");
    }
  }
}

export default new ApiKeyRepository();
