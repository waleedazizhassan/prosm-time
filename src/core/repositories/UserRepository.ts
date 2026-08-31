import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface CurrentUserProfile {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  status: string;
  isOwner: boolean;
  roleKey: string;
  roleName: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface CurrentUserRow {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  status: string;
  is_owner: boolean;
  roles: { role_key: string; name: string } | { role_key: string; name: string }[] | null;
}

function mapCurrentUserRow(row: CurrentUserRow | null): CurrentUserProfile | null {
  if (!row) return null;
  const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    isOwner: row.is_owner,
    roleKey: role?.role_key ?? "",
    roleName: role?.name ?? "",
  };
}

// PROSM Time - the caller's own profile (§12: identity separate from
// auth). RLS ("members can view users in own organization",
// 20260831110000) already scopes this to rows the caller is allowed to
// see; filtering by auth_user_id here selects the caller's own row
// specifically, same convention PROSM Platform's own Edge Functions use
// server-side (see establish-organization-owner's own callerRow lookup).
class UserRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCurrentUser(): Promise<ServiceResult<CurrentUserProfile>> {
    try {
      const {
        data: { user: authUser },
      } = await this.client.auth.getUser();

      if (!authUser) {
        return createError("No authenticated session.");
      }

      const { data, error } = await this.client
        .from("users")
        .select("id, organization_id, email, full_name, status, is_owner, roles(role_key, name)")
        .eq("auth_user_id", authUser.id)
        .maybeSingle();

      if (error) return createError(error.message);
      if (!data) return createError("User profile not found.");

      return createSuccess(mapCurrentUserRow(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "User service unavailable.");
    }
  }
}

export default new UserRepository();
