import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface OrgMember {
  id: string;
  email: string;
  fullName: string;
  status: string;
  isOwner: boolean;
  roleKey: string;
  roleName: string;
  createdAt: string;
}

export interface InviteInput {
  email: string;
  fullName: string;
  roleKey: "manager" | "supervisor" | "employee" | "read_only";
}

export interface InviteResultData {
  userId: string;
  email: string;
  verificationCode: string;
  expiresAt: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface OrgMemberRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  is_owner: boolean;
  created_at: string;
  roles: { role_key: string; name: string } | { role_key: string; name: string }[] | null;
}

function mapMemberRow(row: OrgMemberRow): OrgMember {
  const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    isOwner: row.is_owner,
    roleKey: role?.role_key ?? "",
    roleName: role?.name ?? "",
    createdAt: row.created_at,
  };
}

// PROSM Time - "Employee Management" (§37) + invitations (§12). Reads
// are RLS-scoped to the caller's own organization
// ("members can view users in own organization", 20260831110000);
// inviteUser calls the real invite-user Edge Function, which re-checks
// 'employees.create' server-side - this repository enforces nothing
// itself.
class EmployeeRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listOrganizationMembers(): Promise<ServiceResult<OrgMember[]>> {
    try {
      const { data, error } = await this.client
        .from("users")
        .select("id, email, full_name, status, is_owner, created_at, roles(role_key, name)")
        .order("created_at", { ascending: true });

      if (error) return createError(error.message);

      return createSuccess((data ?? []).map(mapMemberRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async getMember(userId: string): Promise<ServiceResult<OrgMember>> {
    try {
      const { data, error } = await this.client
        .from("users")
        .select("id, email, full_name, status, is_owner, created_at, roles(role_key, name)")
        .eq("id", userId)
        .maybeSingle();

      if (error) return createError(error.message);
      if (!data) return createError("Member not found.");

      return createSuccess(mapMemberRow(data));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async inviteUser(input: InviteInput): Promise<ServiceResult<InviteResultData>> {
    try {
      const { data, error } = await this.client.functions.invoke("invite-user", { body: input });

      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to invite this employee.");
      }
      if (data?.success === false) {
        return createError(data?.error?.message ?? "Unable to invite this employee.");
      }

      return createSuccess(data?.data ?? null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }
}

export default new EmployeeRepository();
