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
  // § live UX review, user-directed - "delete an employee from the
  // application, Owner-only, requires a reason." A deactivated
  // employee can no longer sign in (current_prosm_time_user_id() stops
  // resolving them, 20260903150000) but their historical data is kept
  // - reversible by an Owner, unlike deleteEmployeeData's GDPR purge.
  isActive: boolean;
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
  emailSent: boolean;
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
  is_active: boolean;
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
    isActive: row.is_active,
    roleKey: role?.role_key ?? "",
    roleName: role?.name ?? "",
    createdAt: row.created_at,
  };
}

interface VisibleMemberRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  is_owner: boolean;
  is_active: boolean;
  created_at: string;
  role_key: string | null;
  role_name: string | null;
}

function mapVisibleMemberRow(row: VisibleMemberRow): OrgMember {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    isOwner: row.is_owner,
    isActive: row.is_active,
    roleKey: row.role_key ?? "",
    roleName: row.role_name ?? "",
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

  // Scoped via list_prosm_time_visible_members() rather than a raw
  // `users` select: the Owner sees the whole org, but a Manager must
  // only see herself and the people assigned to a site she manages -
  // not the Owner or unrelated employees (20260902090000).
  async listOrganizationMembers(): Promise<ServiceResult<OrgMember[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_visible_members");

      if (error) return createError(error.message);

      const rows = (data ?? []) as VisibleMemberRow[];
      const sorted = [...rows].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      return createSuccess(sorted.map(mapVisibleMemberRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async getMember(userId: string): Promise<ServiceResult<OrgMember>> {
    try {
      const { data, error } = await this.client
        .from("users")
        .select("id, email, full_name, status, is_owner, is_active, created_at, roles(role_key, name)")
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

  // WP-22/§24 - "Data subject rights: admin can export or delete an
  // individual employee's personal attendance data on request,
  // subject to legal/retention holds."
  async exportEmployeeData(userId: string): Promise<ServiceResult<Record<string, unknown>>> {
    try {
      const { data, error } = await this.client.functions.invoke("export-employee-data", { body: { userId } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to export this employee's data.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to export this employee's data.");
      return createSuccess(data.data as Record<string, unknown>);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async deactivateEmployee(userId: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("deactivate_prosm_time_employee", { p_user_id: userId, p_reason: reason });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to deactivate this employee.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async reactivateEmployee(userId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("reactivate_prosm_time_employee", { p_user_id: userId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to reactivate this employee.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }

  async deleteEmployeeData(userId: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("delete-employee-data", { body: { userId, reason } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to delete this employee's data.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to delete this employee's data.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Employee service unavailable.");
    }
  }
}

export default new EmployeeRepository();
