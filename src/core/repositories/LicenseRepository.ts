import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface LicenseState {
  licenseNumber: string;
  status: string;
  maxUsers: number | null;
  maxDevices: number | null;
  expiresAt: string | null;
  lastVerifiedAt: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface LicenseStateRow {
  license_number: string;
  status: string;
  max_users: number | null;
  max_devices: number | null;
  expires_at: string | null;
  last_verified_at: string;
}

function mapLicenseRow(row: LicenseStateRow | null): LicenseState | null {
  if (!row) return null;
  return {
    licenseNumber: row.license_number,
    status: row.status,
    maxUsers: row.max_users,
    maxDevices: row.max_devices,
    expiresAt: row.expires_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

// PROSM Time - "License & Plan (read-only reflection of PROSM
// Management state)" (§37). This table is a local cache, "never
// authoritative" (§34) - refreshCurrentLicenseStatus() is what keeps it
// honest, by calling the real refresh-license-status Edge Function
// (which itself calls PROSM Management's integration contract), never
// by writing a status here directly.
class LicenseRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCurrentLicenseState(): Promise<ServiceResult<LicenseState>> {
    try {
      const { data, error } = await this.client.from("license_activation_state").select("*").maybeSingle();

      if (error) return createError(error.message);
      if (!data) return createError("No license activation state found.");

      return createSuccess(mapLicenseRow(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "License service unavailable.");
    }
  }

  async refreshCurrentLicenseStatus(): Promise<ServiceResult<{ status: string; expiresAt: string | null }>> {
    try {
      const { data, error } = await this.client.functions.invoke("refresh-license-status", { body: {} });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to refresh license status.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to refresh license status.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "License service unavailable.");
    }
  }
}

export default new LicenseRepository();
