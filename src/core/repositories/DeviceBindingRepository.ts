import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface DeviceBinding {
  id: string;
  userId: string;
  deviceIdentifier: string;
  deviceLabel: string | null;
  status: string;
  approvedAt: string | null;
  createdAt: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface DeviceBindingRow {
  id: string;
  user_id: string;
  device_identifier: string;
  device_label: string | null;
  status: string;
  approved_at: string | null;
  created_at: string;
}

function mapDeviceBindingRow(row: DeviceBindingRow): DeviceBinding {
  return {
    id: row.id,
    userId: row.user_id,
    deviceIdentifier: row.device_identifier,
    deviceLabel: row.device_label,
    status: row.status,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

// PROSM Time - §12's device binding governance (table + admin actions
// only; Clock In enforcement against this table is WP-06's job). Real
// device rows only appear once WP-06's Clock In flow actually creates
// them - an empty list here is honest, not a missing feature.
class DeviceBindingRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listForUser(userId: string): Promise<ServiceResult<DeviceBinding[]>> {
    try {
      const { data, error } = await this.client
        .from("device_bindings")
        .select("id, user_id, device_identifier, device_label, status, approved_at, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) return createError(error.message);

      return createSuccess((data ?? []).map(mapDeviceBindingRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Device binding service unavailable.");
    }
  }

  async setStatus(deviceBindingId: string, status: "approved" | "blocked", reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_device_binding_status", {
        p_device_binding_id: deviceBindingId,
        p_status: status,
        p_reason: reason,
      });

      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to update this device binding.");

      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Device binding service unavailable.");
    }
  }
}

export default new DeviceBindingRepository();
