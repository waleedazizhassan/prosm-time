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
  // § live UX review, user-directed - "a place in the user menu to
  // upload a profile picture."
  avatarUrl: string | null;
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
  avatar_url: string | null;
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
    avatarUrl: row.avatar_url,
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
        .select("id, organization_id, email, full_name, status, is_owner, avatar_url, roles(role_key, name)")
        .eq("auth_user_id", authUser.id)
        .maybeSingle();

      if (error) return createError(error.message);
      if (!data) return createError("User profile not found.");

      return createSuccess(mapCurrentUserRow(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "User service unavailable.");
    }
  }

  // § live UX review, user-directed - "a place in the user menu to
  // upload a profile picture." Mirrors OrganizationRepository.uploadLogo
  // exactly - a public bucket (a profile picture is meant to be seen by
  // teammates, not access-controlled like camera evidence), then the
  // self-service RPC to record it (no direct client UPDATE grant on
  // `users`, matching every other mutation in this codebase).
  async uploadAvatar(userId: string, file: File): Promise<ServiceResult<string>> {
    try {
      const extension = file.name.split(".").pop() || "png";
      const path = `users/${userId}/avatar-${Date.now()}.${extension}`;

      const { error: uploadError } = await this.client.storage.from("user-avatars").upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) return createError(uploadError.message);

      const { data: publicUrlData } = this.client.storage.from("user-avatars").getPublicUrl(path);
      const avatarUrl = publicUrlData.publicUrl;

      const { data, error } = await this.client.rpc("set_prosm_time_own_avatar", { p_avatar_url: avatarUrl });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to set the profile picture.");

      return createSuccess(avatarUrl);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "User service unavailable.");
    }
  }
}

export default new UserRepository();
