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
  // Audit 4.7 - the whole day, not only the session the entry is linked
  // to: the first clock-in, the last clock-out (null while one is still
  // open), how many sessions and the minutes worked in the closed ones.
  clockInAt: string | null;
  clockOutAt: string | null;
  sessionCount: number;
  workedMinutes: number;
  mealAllowance: number;
  expatriationAllowance: number;
  transportationAllowance: number;
  housingAllowance: number;
  travelAllowance: number;
  otherAllowance: number;
  otherAllowanceNote: string | null;
  overtimeHours: number;
  // v2.3.43 step 4: the exact overtime minutes (the amount is rate x minutes / 60).
  overtimeMinutes: number;
  overtimeDays: number;
  // Owner 2026-10-20: overtime hours and extra days priced from the allowance prices.
  overtimeAmount: number;
  extraDaysAmount: number;
  status: AllowanceEntryStatus;
  submittedAt: string | null;
  approvedAt: string | null;
  // Owner 2026-10-20: the reviewer's note on the decision (why it was rejected).
  reviewNotes: string | null;
  // Owner 2026-10-20: the sheet the day was sent in (decided with it, never alone).
  sheetId: string | null;
}

export interface AllowanceSheet {
  id: string;
  userId: string;
  userFullName: string;
  periodStart: string;
  periodEnd: string;
  days: number;
  total: number;
  status: "submitted" | "approved" | "rejected";
  submittedAt: string;
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
  overtime_minutes?: number;
  worked_minutes?: number;
  overtime_amount?: number;
  extra_days_amount?: number;
  status: AllowanceEntryStatus;
  submitted_at: string | null;
  approved_at: string | null;
  review_notes: string | null;
  sheet_id?: string | null;
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
    sessionCount: session ? 1 : 0,
    workedMinutes: row.worked_minutes ? Math.round(Number(row.worked_minutes)) : session?.clock_out_at ? Math.max(0, Math.round((new Date(session.clock_out_at).getTime() - new Date(session.clock_in_at).getTime()) / 60000)) : 0,
    mealAllowance: row.meal_allowance,
    expatriationAllowance: row.expatriation_allowance,
    transportationAllowance: row.transportation_allowance,
    housingAllowance: row.housing_allowance,
    travelAllowance: row.travel_allowance,
    otherAllowance: row.other_allowance,
    otherAllowanceNote: row.other_allowance_note,
    overtimeHours: Number(row.overtime_hours),
    overtimeMinutes: Number(row.overtime_minutes ?? Number(row.overtime_hours) * 60),
    overtimeDays: Number(row.overtime_days),
    overtimeAmount: Number(row.overtime_amount ?? 0),
    extraDaysAmount: Number(row.extra_days_amount ?? 0),
    status: row.status,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    reviewNotes: row.review_notes ?? null,
    sheetId: row.sheet_id ?? null,
  };
}

// allowance_entries has two FKs to users (user_id, approved_by) -
// the embed must be qualified with the constraint name or PostgREST
// rejects it as ambiguous (the exact same bug class audited and
// fixed across timesheets/project_assignments/site_assignments
// earlier this session).
export interface DaySession {
  clockInAt: string;
  clockOutAt: string | null;
}

/** First clock-in, last clock-out (null while a session is open), count and closed minutes of one day. */
export function summarizeDay(sessions: DaySession[]): Pick<AllowanceEntry, "clockInAt" | "clockOutAt" | "sessionCount" | "workedMinutes"> {
  if (sessions.length === 0) return { clockInAt: null, clockOutAt: null, sessionCount: 0, workedMinutes: 0 };
  const sorted = [...sessions].sort((a, b) => a.clockInAt.localeCompare(b.clockInAt));
  const open = sorted.some((session) => session.clockOutAt === null);
  const lastOut = sorted.reduce<string | null>((latest, session) => (session.clockOutAt && (!latest || session.clockOutAt > latest) ? session.clockOutAt : latest), null);
  const workedMinutes = sorted.reduce(
    (total, session) => total + (session.clockOutAt ? Math.max(0, Math.round((new Date(session.clockOutAt).getTime() - new Date(session.clockInAt).getTime()) / 60000)) : 0),
    0,
  );
  return { clockInAt: sorted[0].clockInAt, clockOutAt: open ? null : lastOut, sessionCount: sorted.length, workedMinutes };
}

function localDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const ENTRY_SELECT =
  "id, user_id, entry_date, meal_allowance, expatriation_allowance, transportation_allowance, housing_allowance, travel_allowance, other_allowance, other_allowance_note, overtime_hours, overtime_minutes, worked_minutes, overtime_days, overtime_amount, extra_days_amount, status, submitted_at, approved_at, review_notes, sheet_id, users!allowance_entries_user_id_fkey(full_name), attendance_sessions(clock_in_at, clock_out_at, manual_location_label, sites!attendance_sessions_site_id_fkey(name))";

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
      const entries = (data ?? []).map(mapEntryRow);
      return createSuccess(await this.withWholeDays(entries, startDate, endDate));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  // Audit 4.7 - an entry is for the whole day: read every session of that
  // person on that day (same reach as the Attendance Log) and summarise.
  // If they can't be read, the entry keeps its own linked session.
  private async withWholeDays(entries: AllowanceEntry[], startDate: string, endDate: string): Promise<AllowanceEntry[]> {
    if (entries.length === 0) return entries;
    const from = new Date(`${startDate}T00:00:00`).toISOString();
    const to = new Date(`${endDate}T23:59:59.999`).toISOString();
    const { data, error } = await this.client
      .from("attendance_sessions")
      .select("user_id, clock_in_at, clock_out_at")
      .in("user_id", [...new Set(entries.map((entry) => entry.userId))])
      .gte("clock_in_at", from)
      .lte("clock_in_at", to);
    if (error || !data) return entries;

    const byDay = new Map<string, DaySession[]>();
    for (const row of data as Array<{ user_id: string; clock_in_at: string; clock_out_at: string | null }>) {
      const key = `${row.user_id}:${localDate(row.clock_in_at)}`;
      const list = byDay.get(key) ?? [];
      list.push({ clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at });
      byDay.set(key, list);
    }
    return entries.map((entry) => {
      const sessions = byDay.get(`${entry.userId}:${entry.entryDate}`);
      return sessions && sessions.length > 0 ? { ...entry, ...summarizeDay(sessions) } : entry;
    });
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

  // Owner 2026-10-20: every day worked in the period, filled from the allowance prices
  // (days already started are left as they are).
  async fillFromAttendance(from: string, to: string): Promise<ServiceResult<{ filled: number }>> {
    try {
      const { data, error } = await this.client.rpc("fill_prosm_time_allowances", { p_from: from, p_to: to });
      if (error) return createError(error.message);
      return createSuccess({ filled: Number((data as { filled?: number } | null)?.filled ?? 0) });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  // Owner 2026-10-20: auto-fill (each clocked-out day starts itself) and "send to manager" for a whole period.
  async getAutoFill(): Promise<ServiceResult<boolean>> {
    try {
      const { data, error } = await this.client.from("allowance_preferences").select("auto_fill").maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(Boolean((data as { auto_fill?: boolean } | null)?.auto_fill));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async setAutoFill(enabled: boolean): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_allowance_auto_fill", { p_enabled: enabled });
      return error ? createError(error.message) : createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async submitPeriod(from: string, to: string): Promise<ServiceResult<{ sent: number }>> {
    try {
      const { data, error } = await this.client.rpc("submit_prosm_time_allowances", { p_from: from, p_to: to });
      if (error) return createError(error.message);
      return createSuccess({ sent: Number((data as { sent?: number } | null)?.sent ?? 0) });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async listSheets(status: AllowanceSheet["status"] = "submitted"): Promise<ServiceResult<AllowanceSheet[]>> {
    try {
      const { data, error } = await this.client
        .from("allowance_sheets")
        .select("id, user_id, period_start, period_end, days, total, status, submitted_at, users!allowance_sheets_user_id_fkey(full_name)")
        .eq("status", status)
        .order("submitted_at", { ascending: true });
      if (error) return createError(error.message);
      type Row = { id: string; user_id: string; period_start: string; period_end: string; days: number; total: number; status: AllowanceSheet["status"]; submitted_at: string; users: { full_name: string } | { full_name: string }[] | null };
      return createSuccess(
        ((data ?? []) as Row[]).map((row) => {
          const user = Array.isArray(row.users) ? row.users[0] : row.users;
          return { id: row.id, userId: row.user_id, userFullName: user?.full_name ?? "", periodStart: row.period_start, periodEnd: row.period_end, days: row.days, total: Number(row.total), status: row.status, submittedAt: row.submitted_at };
        }),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async reviewSheet(sheetId: string, action: "approved" | "rejected", notes?: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("review_prosm_time_allowance_sheet", { p_sheet_id: sheetId, p_action: action, p_notes: notes ?? null });
      return error ? createError(error.message) : createSuccess();
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
