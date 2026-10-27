import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

// v2.3.43 step 7 (item 25): leave types are the organisation's settings
// (leave_types); the built-in keys are annual, emergency (casual), sick,
// unpaid, hajj, bereavement, paternity and other, and an Owner may add more.
export type LeaveType = string;

export interface LeaveTypeSetting {
  id: string;
  key: string;
  name: string;
  isPaid: boolean;
  annualDays: number | null;
  serviceTiers: { minYears: number; days: number }[] | null;
  specialNeedsDays: number | null;
  enforceBalance: boolean;
  maxDaysPerRequest: number | null;
  maxTimesInService: number | null;
  minServiceYears: number | null;
  requiresDocument: boolean;
  isActive: boolean;
  sortOrder: number;
  legalNote: string | null;
}
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequestRow {
  id: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string | null;
  status: LeaveStatus;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  // v2.3.43 step 9: the unpaid-leave deduction the employee sees.
  deductionTotal: number | null;
  deductionCurrency: string | null;
}

export interface OrgWideLeaveRow {
  id: string;
  userId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string | null;
  status: LeaveStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface PendingLeaveReviewRow {
  id: string;
  userId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string | null;
  createdAt: string;
}

export interface ApprovedLeaveRow {
  id: string;
  userId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  // v2.3.43 step 8 (item 20): false from the first day of the leave on.
  canCancel: boolean;
}

export interface LeaveBalanceEntry {
  leaveType: LeaveType;
  name?: string;
  entitledDays: number | null;
  // v2.3.43 step 7: the entitlement from the type's rules, the one set by hand (wins), and whether they differ.
  computedDays?: number | null;
  setDays?: number | null;
  differs?: boolean;
  usedDays: number;
  pendingDays: number;
  remainingDays: number | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface LeaveRequestRowRaw {
  id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string | null;
  status: LeaveStatus;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  deduction_total?: number | null;
  deduction_currency?: string | null;
}

function mapRow(row: LeaveRequestRowRaw): LeaveRequestRow {
  return {
    id: row.id,
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    daysCount: row.days_count,
    reason: row.reason,
    status: row.status,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    deductionTotal: row.deduction_total === null || row.deduction_total === undefined ? null : Number(row.deduction_total),
    deductionCurrency: row.deduction_currency ?? null,
  };
}

// PROSM Time - § user-directed: real PTO/leave management (request ->
// supervisor review -> notification), a genuine gap versus every
// competitor researched this session. Balance tracking (entitled/used/
// remaining) is real only for 'annual' leave - see the migration's own
// header comment for why the other types deliberately never show a
// hard cap, only a "days taken this year" figure.
class LeaveRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  // Own requests only (audit 1.2) - RLS also shows a manager the
  // requests of the employees at their sites.
  async listMine(userId: string): Promise<ServiceResult<LeaveRequestRow[]>> {
    try {
      const { data, error } = await this.client
        .from("leave_requests")
        .select("id, leave_type, start_date, end_date, days_count, reason, status, reviewed_at, review_notes, created_at, deduction_total, deduction_currency")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  // § user-directed, 2026-09-16 - the Owner's own Leave page: an
  // org-wide view of every leave request (not just their own), backed
  // by list_prosm_time_all_leave_requests (Owner-only server-side).
  async listAll(): Promise<ServiceResult<OrgWideLeaveRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_all_leave_requests");
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map(
          (row: {
            id: string;
            user_id: string;
            employee_name: string;
            leave_type: LeaveType;
            start_date: string;
            end_date: string;
            days_count: number;
            reason: string | null;
            status: LeaveStatus;
            reviewed_by_name: string | null;
            reviewed_at: string | null;
            created_at: string;
          }) => ({
            id: row.id,
            userId: row.user_id,
            employeeName: row.employee_name,
            leaveType: row.leave_type,
            startDate: row.start_date,
            endDate: row.end_date,
            daysCount: row.days_count,
            reason: row.reason,
            status: row.status,
            reviewedByName: row.reviewed_by_name,
            reviewedAt: row.reviewed_at,
            createdAt: row.created_at,
          }),
        ),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async getBalance(): Promise<ServiceResult<{ year: number; balances: LeaveBalanceEntry[] }>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_leave_balance", {});
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to load your leave balance.");
      return createSuccess({
        year: data.year,
        balances: (data.balances ?? []).map((entry: LeaveBalanceEntry) => ({
          leaveType: entry.leaveType,
          name: entry.name,
          computedDays: entry.computedDays ?? null,
          setDays: entry.setDays ?? null,
          differs: Boolean(entry.differs),
          entitledDays: entry.entitledDays,
          usedDays: entry.usedDays,
          pendingDays: entry.pendingDays,
          remainingDays: entry.remainingDays,
        })),
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async listTypes(): Promise<ServiceResult<LeaveTypeSetting[]>> {
    try {
      const { data, error } = await this.client.from("leave_types").select("*").order("sort_order", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: String(row.id),
          key: String(row.key),
          name: String(row.name),
          isPaid: Boolean(row.is_paid),
          annualDays: row.annual_days === null ? null : Number(row.annual_days),
          serviceTiers: (row.service_tiers as LeaveTypeSetting["serviceTiers"]) ?? null,
          specialNeedsDays: row.special_needs_days === null ? null : Number(row.special_needs_days),
          enforceBalance: Boolean(row.enforce_balance),
          maxDaysPerRequest: row.max_days_per_request === null ? null : Number(row.max_days_per_request),
          maxTimesInService: row.max_times_in_service === null ? null : Number(row.max_times_in_service),
          minServiceYears: row.min_service_years === null ? null : Number(row.min_service_years),
          requiresDocument: Boolean(row.requires_document),
          isActive: Boolean(row.is_active),
          sortOrder: Number(row.sort_order),
          legalNote: (row.legal_note as string | null) ?? null,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async saveType(id: string | null, key: string, type: Partial<LeaveTypeSetting>): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("save_prosm_time_leave_type", { p_id: id, p_key: key, p_type: type });
      return error ? createError(error.message) : createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  // A medical report or other document, in the person's own private folder.
  async uploadDocument(organizationId: string, userId: string, file: File): Promise<ServiceResult<string>> {
    try {
      const extension = file.name.includes(".") ? file.name.split(".").pop() : "pdf";
      const path = `${organizationId}/${userId}/${crypto.randomUUID()}.${extension}`;
      const { error } = await this.client.storage.from("leave-documents").upload(path, file, { contentType: file.type || "application/pdf", upsert: false });
      return error ? createError(error.message) : createSuccess(path);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async documentUrl(path: string): Promise<ServiceResult<string>> {
    try {
      const { data, error } = await this.client.storage.from("leave-documents").createSignedUrl(path, 300);
      return error || !data ? createError(error?.message ?? "Document unavailable.") : createSuccess(data.signedUrl);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async getEmploymentDetails(userId: string): Promise<ServiceResult<{ hireDate: string | null; specialNeeds: boolean; serviceYears: number | null }>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_employment_details", { p_user_id: userId });
      return error ? createError(error.message) : createSuccess(data as { hireDate: string | null; specialNeeds: boolean; serviceYears: number | null });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async setEmploymentDetails(userId: string, hireDate: string | null, specialNeeds: boolean): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_employment_details", { p_user_id: userId, p_hire_date: hireDate, p_special_needs: specialNeeds });
      return error ? createError(error.message) : createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  /** v2.3.55 (owner 2026-10-27): the people who may approve my leave - the requester picks one. */
  async listReviewers(): Promise<ServiceResult<{ id: string; name: string; isOwner: boolean }[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_leave_reviewers");
      if (error) return createError(error.message);
      return createSuccess(Array.isArray(data) ? data : []);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async request(
    leaveType: LeaveType,
    startDate: string,
    endDate: string,
    reason?: string,
    documentPath?: string | null,
    reviewerId?: string | null,
  ): Promise<ServiceResult<{ requestId: string; daysCount: number; autoApproved: boolean }>> {
    try {
      const { data, error } = await this.client.rpc("request_prosm_time_leave", {
        p_leave_type: leaveType,
        p_start_date: startDate,
        p_end_date: endDate,
        p_reason: reason?.trim() || null,
        p_document_path: documentPath ?? null,
        p_reviewer_id: reviewerId || null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to submit this leave request.");
      return createSuccess({ requestId: data.requestId, daysCount: data.daysCount, autoApproved: Boolean(data.autoApproved) });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async suggestDeduction(requestId: string): Promise<ServiceResult<{ perDay: number | null; currency: string; days: number; rateType: string | null }>> {
    try {
      const { data, error } = await this.client.rpc("suggest_prosm_time_leave_deduction", { p_request_id: requestId });
      return error ? createError(error.message) : createSuccess(data as { perDay: number | null; currency: string; days: number; rateType: string | null });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async listPayrollAdjustments(userId: string | null, from: string, to: string): Promise<ServiceResult<{ userId: string; workDate: string; amount: number; currency: string; kind: string }[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_payroll_adjustments", { p_user_id: userId, p_from: from, p_to: to });
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as { user_id: string; work_date: string; amount: number; currency: string; kind: string }[]).map((row) => ({
          userId: row.user_id,
          workDate: row.work_date,
          amount: Number(row.amount),
          currency: row.currency,
          kind: row.kind,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async cancel(requestId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("cancel_prosm_time_leave_request", { p_request_id: requestId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to cancel this leave request.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async listPendingReview(): Promise<ServiceResult<PendingLeaveReviewRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_pending_leave_requests");
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { id: string; user_id: string; employee_name: string; leave_type: LeaveType; start_date: string; end_date: string; days_count: number; reason: string | null; created_at: string }) => ({
          id: row.id,
          userId: row.user_id,
          employeeName: row.employee_name,
          leaveType: row.leave_type,
          startDate: row.start_date,
          endDate: row.end_date,
          daysCount: row.days_count,
          reason: row.reason,
          createdAt: row.created_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  // v2.3.43 step 9 (item 19): unpaid leave is approved with its deduction per day.
  /** Owner 2026-10-27: an approved leave recorded on someone's behalf (asked by phone), past days included. */
  async grant(
    userId: string,
    leaveType: string,
    startDate: string,
    endDate: string,
    notes?: string,
    deductionPerDay?: number | null,
  ): Promise<ServiceResult<{ requestId: string; days: number; timesheetsUpdated: number; timesheetsToReopen: number }>> {
    try {
      const { data, error } = await this.client.rpc("grant_prosm_time_leave", {
        p_user_id: userId,
        p_leave_type: leaveType,
        p_start_date: startDate,
        p_end_date: endDate,
        p_notes: notes?.trim() || null,
        p_deduction_per_day: deductionPerDay ?? null,
      });
      if (error) return createError(error.message);
      return createSuccess(data);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async review(requestId: string, action: "approved" | "rejected", notes?: string, deductionPerDay?: number | null): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("review_prosm_time_leave", {
        p_request_id: requestId,
        p_action: action,
        p_notes: notes?.trim() || null,
        p_deduction_per_day: deductionPerDay ?? null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to review this leave request.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async listApproved(upcomingOnly = true): Promise<ServiceResult<ApprovedLeaveRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_approved_leave_requests", { p_upcoming_only: upcomingOnly });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map(
          (row: {
            id: string;
            user_id: string;
            employee_name: string;
            leave_type: LeaveType;
            start_date: string;
            end_date: string;
            days_count: number;
            reason: string | null;
            reviewed_by_name: string | null;
            reviewed_at: string | null;
            can_cancel?: boolean | null;
          }) => ({
            id: row.id,
            userId: row.user_id,
            employeeName: row.employee_name,
            leaveType: row.leave_type,
            startDate: row.start_date,
            endDate: row.end_date,
            daysCount: row.days_count,
            reason: row.reason,
            reviewedByName: row.reviewed_by_name,
            reviewedAt: row.reviewed_at,
            canCancel: row.can_cancel ?? false,
          }),
        ),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  // Revoking an already-approved leave request reuses review_prosm_
  // time_leave's own 'rejected' action - the RPC has always accepted
  // this (see its own header comment), this repository method just
  // names the real intent clearly at the call site rather than making
  // every caller remember that "reject" is also how you revoke.
  async revokeApproved(requestId: string, notes: string): Promise<ServiceResult> {
    return this.review(requestId, "rejected", notes);
  }

  // § real request, user-directed: an Owner-only override for a
  // specific employee's annual entitlement (real Egyptian labor-law
  // context - 10+ years of social-insurance tenure legally entitles 30
  // days/year, not the org's own 21-day default). Wraps the RPC that
  // already existed but had no UI anywhere.
  async getBalanceFor(userId: string, year?: number): Promise<ServiceResult<{ year: number; balances: LeaveBalanceEntry[] }>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_leave_balance", { p_user_id: userId, p_year: year ?? null });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to load this employee's leave balance.");
      return createSuccess({
        year: data.year,
        balances: (data.balances ?? []).map((entry: { leaveType: LeaveType; entitledDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }) => ({
          leaveType: entry.leaveType,
          entitledDays: entry.entitledDays,
          usedDays: entry.usedDays,
          pendingDays: entry.pendingDays,
          remainingDays: entry.remainingDays,
        })),
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  async setAnnualEntitlement(userId: string, year: number, entitledDays: number): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("set_prosm_time_leave_entitlement", {
        p_user_id: userId,
        p_leave_type: "annual",
        p_year: year,
        p_entitled_days: entitledDays,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to update this employee's leave entitlement.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }

  // § user-directed - Dashboard KPI audit: "today I have 5 on leave,
  // click the card, see their names and sites." leave_requests' own
  // RLS (self OR owner OR exceptions.manage - 20260908210000) already
  // scopes this correctly: a plain employee only ever sees their own
  // row here (matching every other KPI's "own-scope numbers" posture),
  // an authorized reviewer sees everyone genuinely on leave today.
  async listToday(): Promise<ServiceResult<{ id: string; userId: string; employeeName: string; leaveType: LeaveType; endDate: string }[]>> {
    interface RawTodayLeaveRow {
      id: string;
      user_id: string;
      leave_type: LeaveType;
      end_date: string;
      users: { full_name: string } | { full_name: string }[] | null;
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await this.client
        .from("leave_requests")
        .select("id, user_id, leave_type, end_date, users!leave_requests_user_id_fkey(full_name)")
        .eq("status", "approved")
        .lte("start_date", today)
        .gte("end_date", today);
      if (error) return createError(error.message);
      return createSuccess(
        ((data ?? []) as RawTodayLeaveRow[]).map((row) => {
          const user = Array.isArray(row.users) ? row.users[0] : row.users;
          return { id: row.id, userId: row.user_id, employeeName: user?.full_name ?? "", leaveType: row.leave_type, endDate: row.end_date };
        }),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Leave service unavailable.");
    }
  }
}

export default new LeaveRepository();
