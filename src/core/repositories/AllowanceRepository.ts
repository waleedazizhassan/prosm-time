import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export type AllowanceEntryStatus = "draft" | "submitted" | "approved" | "rejected";

export interface AllowanceEntry {
  id: string;
  userId: string;
  userFullName: string;
  entryDate: string;
  siteName: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  mealAllowance: number;
  expatriationAllowance: number;
  transportationAllowance: number;
  housingAllowance: number;
  travelAllowance: number;
  otherAllowance: number;
  otherAllowanceNote: string | null;
  overtimeHours: number;
  overtimeDays: number;
  status: AllowanceEntryStatus;
  submittedAt: string | null;
  approvedAt: string | null;
}

export interface AllowanceEntryInput {
  mealAllowance: number;
  expatriationAllowance: number;
  transportationAllowance: number;
  housingAllowance: number;
  travelAllowance: number;
  otherAllowance: number;
  otherAllowanceNote: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface AllowanceEntryRow {
  id: string;
  user_id: string;
  entry_date: string;
  meal_allowance: number;
  expatriation_allowance: number;
  transportation_allowance: number;
  housing_allowance: number;
  travel_allowance: number;
  other_allowance: number;
  other_allowance_note: string | null;
  overtime_hours: number;
  overtime_days: number;
  status: AllowanceEntryStatus;
  submitted_at: string | null;
  approved_at: string | null;
  users: { full_name: string } | { full_name: string }[] | null;
  attendance_sessions:
    | { clock_in_at: string; clock_out_at: string | null; manual_location_label: string | null; sites: { name: string } | { name: string }[] | null }
    | { clock_in_at: string; clock_out_at: string | null; manual_location_label: string | null; sites: { name: string } | { name: string }[] | null }[]
    | null;
}

function mapEntryRow(row: AllowanceEntryRow): AllowanceEntry {
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  const session = Array.isArray(row.attendance_sessions) ? row.attendance_sessions[0] : row.attendance_sessions;
  const site = session ? (Array.isArray(session.sites) ? session.sites[0] : session.sites) : null;
  return {
    id: row.id,
    userId: row.user_id,
    userFullName: user?.full_name ?? "",
    entryDate: row.entry_date,
    siteName: site?.name ?? session?.manual_location_label ?? null,
    clockInAt: session?.clock_in_at ?? null,
    clockOutAt: session?.clock_out_at ?? null,
    mealAllowance: row.meal_allowance,
    expatriationAllowance: row.expatriation_allowance,
    transportationAllowance: row.transportation_allowance,
    housingAllowance: row.housing_allowance,
    travelAllowance: row.travel_allowance,
    otherAllowance: row.other_allowance,
    otherAllowanceNote: row.other_allowance_note,
    overtimeHours: row.overtime_hours,
    overtimeDays: row.overtime_days,
    status: row.status,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
  };
}

// allowance_entries has two FKs to users (user_id, approved_by) -
// the embed must be qualified with the constraint name or PostgREST
// rejects it as ambiguous (the exact same bug class audited and
// fixed across timesheets/project_assignments/site_assignments
// earlier this session).
const ENTRY_SELECT =
  "id, user_id, entry_date, meal_allowance, expatriation_allowance, transportation_allowance, housing_allowance, travel_allowance, other_allowance, other_allowance_note, overtime_hours, overtime_days, status, submitted_at, approved_at, users!allowance_entries_user_id_fkey(full_name), attendance_sessions(clock_in_at, clock_out_at, manual_location_label, sites(name))";

// PROSM Time - Allowances (2026-09-02 plan). Reads are RLS-scoped
// (self always; a Manager's own managed sites' people; everyone for
// the Owner - allowance_entries' own policy, 20260902140000); every
// write is a real Edge Function -> RPC
// (upsert/submit/approve_prosm_time_allowance_entry) that re-checks
// ownership/status/authority server-side - this repository enforces
// nothing itself.
class AllowanceRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listEntries(startDate: string, endDate: string): Promise<ServiceResult<AllowanceEntry[]>> {
    try {
      const { data, error } = await this.client
        .from("allowance_entries")
        .select(ENTRY_SELECT)
        .gte("entry_date", startDate)
        .lte("entry_date", endDate)
        .order("entry_date", { ascending: false });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapEntryRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async upsertEntry(entryDate: string, input: AllowanceEntryInput): Promise<ServiceResult<{ entryId: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("upsert-allowance-entry", {
        body: {
          entryDate,
          mealAllowance: input.mealAllowance,
          expatriationAllowance: input.expatriationAllowance,
          transportationAllowance: input.transportationAllowance,
          housingAllowance: input.housingAllowance,
          travelAllowance: input.travelAllowance,
          otherAllowance: input.otherAllowance,
          otherAllowanceNote: input.otherAllowanceNote,
        },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to save this allowance entry.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to save this allowance entry.");
      return createSuccess({ entryId: data.data.entryId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async submitEntry(entryId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("submit-allowance-entry", { body: { entryId } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to submit this allowance entry.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to submit this allowance entry.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async approveEntry(entryId: string, action: "approved" | "rejected", notes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("approve-allowance-entry", { body: { entryId, action, notes: notes ?? null } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to review this allowance entry.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to review this allowance entry.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }
}

export default new AllowanceRepository();
