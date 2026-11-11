import { requireSupabaseClient } from "../api/supabaseClient";

// HR suite feature 3 (2026-11-11): the full employee profile - one place for everything about a person.
// The server decides what the reader may see (full / manager / self) and checks every change.

export type ProfileAccess = "full" | "manager" | "self";
export type EmploymentStatus = "active" | "suspended" | "ended";
export type ContractType = "fixed_term" | "open_ended" | "temporary";

export interface EmployeeContract {
  id: string;
  type: ContractType;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  filePath: string | null;
  notes: string | null;
}

export interface EmployeeProfile {
  access: ProfileAccess;
  canEdit: boolean;
  header: {
    id: string;
    fullName: string;
    avatarUrl: string | null;
    email: string;
    isActive: boolean;
    isOwner: boolean;
    employmentStatus: EmploymentStatus;
    roleKey: string;
    jobTitleId: string | null;
    jobTitle: string | null;
    siteName: string | null;
    departmentName: string | null;
    hireDate: string | null;
    employeeCode: string | null;
    legalName: string | null;
  };
  personal: {
    phone: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    nationalId: string | null;
    birthDate: string | null;
    address: string | null;
  };
  contracts: EmployeeContract[] | null;
  /** Feature 2: the share of mandatory documents in place (null until there are mandatory ones). */
  completion?: { percent: number; missing: number } | null;
}

export interface JobTitle {
  id: string;
  name: string;
  isActive: boolean;
  people: number;
}

export interface HistoryEntry {
  id: string;
  action: string;
  createdAt: string;
  reason: string | null;
  actorName: string | null;
}

export interface ActivityDay {
  day: string;
  state: "worked" | "absent";
  firstIn?: string | null;
  lastOut?: string | null;
  workedMinutes?: number | null;
  lateMinutes?: number | null;
  earlyLeaveMinutes?: number | null;
  overtimeMinutes?: number | null;
  site?: string | null;
}

export interface EmployeeActivity {
  days: number;
  totals: { worked: number; late: number; absent: number; workedMinutes: number };
  attendance: ActivityDay[];
  leave: { id: string; type: string; startDate: string; endDate: string; days: number; status: string }[];
}

type Result<T> = { data: T | null; error: string | null };

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const { data, error } = await requireSupabaseClient().rpc(name, args);
    if (error) return { data: null, error: error.message };
    return { data: data as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Service unavailable." };
  }
}

const EmployeeProfileRepository = {
  get: (userId: string) => rpc<EmployeeProfile>("get_prosm_time_employee_profile", { p_user_id: userId }),
  saveHrData: (userId: string, data: Record<string, string | null>) => rpc<{ success: boolean }>("save_prosm_time_employee_hr_data", { p_user_id: userId, p_data: data }),
  listJobTitles: () => rpc<JobTitle[]>("list_prosm_time_job_titles"),
  saveJobTitle: (id: string | null, name: string, isActive = true) => rpc<{ id: string }>("save_prosm_time_job_title", { p_id: id, p_name: name, p_is_active: isActive }),
  saveContract: (id: string | null, userId: string, data: Record<string, string | null>) =>
    rpc<{ id: string }>("save_prosm_time_employee_contract", { p_id: id, p_user_id: userId, p_data: data }),
  deleteContract: (id: string) => rpc<{ success: boolean }>("delete_prosm_time_employee_contract", { p_id: id }),
  history: (userId: string, before: string | null = null) => rpc<HistoryEntry[]>("list_prosm_time_employee_history", { p_user_id: userId, p_before: before, p_limit: 50 }),
  activity: (userId: string, days = 30) => rpc<EmployeeActivity>("get_prosm_time_employee_activity", { p_user_id: userId, p_days: days }),

  /** A personnel file (contract, document) into the private bucket: <organisation>/<person>/<random>.<ext> */
  async uploadFile(organizationId: string, userId: string, file: Blob, extension: string): Promise<Result<string>> {
    try {
      const path = `${organizationId}/${userId}/${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin"}`;
      const { error } = await requireSupabaseClient().storage.from("hr-files").upload(path, file, { upsert: false, contentType: file.type || undefined });
      if (error) return { data: null, error: error.message };
      return { data: path, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "Upload failed." };
    }
  },

  /** A short-lived link to open a personnel file (the bucket is private). */
  async fileUrl(path: string): Promise<string | null> {
    try {
      const { data } = await requireSupabaseClient().storage.from("hr-files").createSignedUrl(path, 300);
      return data?.signedUrl ?? null;
    } catch {
      return null;
    }
  },
};

export default EmployeeProfileRepository;
