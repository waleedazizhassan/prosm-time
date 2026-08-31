import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface Permission {
  id: string;
  permissionKey: string;
  resource: string;
  actionType: string;
  name: string;
  description: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time - §9's granular permission model. Every mutation here is a
// real RPC (set_prosm_time_user_permission_override/
// clear_prosm_time_user_permission_override) that itself re-checks the
// caller's authority server-side - this repository has no privileged
// path of its own, it only calls what already exists.
class PermissionRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listCatalog(): Promise<ServiceResult<Permission[]>> {
    try {
      const { data, error } = await this.client
        .from("permissions")
        .select("id, permission_key, resource, action_type, name, description")
        .order("resource", { ascending: true });

      if (error) return createError(error.message);

      return createSuccess(
        (data ?? []).map((row) => ({
          id: row.id,
          permissionKey: row.permission_key,
          resource: row.resource,
          actionType: row.action_type,
          name: row.name,
          description: row.description,
        }))
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Permission service unavailable.");
    }
  }

  async getEffectivePermissions(userId?: string): Promise<ServiceResult<string[]>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_effective_permissions", {
        p_user_id: userId ?? null,
      });

      if (error) return createError(error.message);

      return createSuccess(data ?? []);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Permission service unavailable.");
    }
  }

  async setOverride(targetUserId: string, permissionKey: string, isGranted: boolean, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_user_permission_override", {
        p_target_user_id: targetUserId,
        p_permission_key: permissionKey,
        p_is_granted: isGranted,
        p_reason: reason,
      });

      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to update this permission.");

      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Permission service unavailable.");
    }
  }

  async getUserOverrides(targetUserId: string): Promise<ServiceResult<Record<string, boolean>>> {
    try {
      const { data, error } = await this.client
        .from("user_permission_overrides")
        .select("is_granted, permissions(permission_key)")
        .eq("user_id", targetUserId);

      if (error) return createError(error.message);

      const overrides: Record<string, boolean> = {};
      for (const row of data ?? []) {
        const permission = Array.isArray(row.permissions) ? row.permissions[0] : row.permissions;
        if (permission?.permission_key) {
          overrides[permission.permission_key] = row.is_granted;
        }
      }

      return createSuccess(overrides);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Permission service unavailable.");
    }
  }

  async clearOverride(targetUserId: string, permissionKey: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("clear_prosm_time_user_permission_override", {
        p_target_user_id: targetUserId,
        p_permission_key: permissionKey,
        p_reason: reason,
      });

      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to clear this permission override.");

      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Permission service unavailable.");
    }
  }
}

export default new PermissionRepository();
