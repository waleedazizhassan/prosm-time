import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

// 2026-11-08 general integration API (migration 20261108150000, Edge Function api-v1): a key
// holds several read-only scopes, may expire, and is either live or test. Created and revoked by
// the owner; the plaintext is returned once, from generate() only.
export const API_SCOPES = ["employees:read", "employees:read_sensitive", "sites:read", "attendance:read", "attendance:write", "leaves:read", "shifts:read", "payroll:read"] as const;
export type ApiKeyScope = (typeof API_SCOPES)[number];
export type ApiKeyEnvironment = "live" | "test";

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  environment: ApiKeyEnvironment;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  requests7d: number;
}

export interface NewApiKey {
  name: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  environment: ApiKeyEnvironment;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

/** The address other systems call; the key goes in "Authorization: Bearer <key>". */
export function apiBaseUrl(): string {
  return `${String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1/api-v1`;
}

class ApiKeyRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async list(): Promise<ServiceResult<ApiKeySummary[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_api_keys");
      if (error) return createError(error.message);
      return createSuccess(((data ?? []) as ApiKeySummary[]).map((key) => ({ ...key, requests7d: Number(key.requests7d ?? 0) })));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "API key service unavailable.");
    }
  }

  async generate(input: NewApiKey): Promise<ServiceResult<{ keyId: string; apiKey: string }>> {
    try {
      const { data, error } = await this.client.rpc("generate_prosm_time_api_key_v2", {
        p_name: input.name,
        p_scopes: input.scopes,
        p_expires_at: input.expiresAt,
        p_environment: input.environment,
      });
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
