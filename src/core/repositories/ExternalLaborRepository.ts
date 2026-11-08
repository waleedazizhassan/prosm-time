import DatabaseManager from "../database/DatabaseManager";

// 2026-11-08 B-07: external labour pay (migration 20261108170000). Every rule - scope, units,
// the policy, the day-rate rule, approval and the frozen snapshot - is enforced by the server;
// this repository only calls it. External workers never mix with employees or payroll.

export type RateUnit = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export const RATE_UNITS: RateUnit[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "HOURLY"];

export interface Result<T> {
  data: T | null;
  error: string | null;
}

export interface ExternalRate {
  unit: RateUnit;
  amount: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface ExternalWorkerRates {
  workerId: string;
  name: string;
  workerNumber: string;
  contractorName: string | null;
  siteId: string | null;
  siteName: string | null;
  status: string;
  current: ExternalRate | null;
  history: ExternalRate[];
  canManage: boolean;
}

export interface ExternalSettings {
  dayRateBasis: "fixed" | "calendar" | "working";
  fixedDivisor: number;
  canManagePolicy: boolean;
}

export interface PolicyItem {
  id?: string;
  name: string;
  kind: "deduction" | "addition";
  calc: "fixed" | "percent";
  value: number;
  currency: string | null;
  isActive: boolean;
  sortOrder?: number;
  rowVersion?: number;
}

export interface RunSummary {
  id: string;
  title: string;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "approved";
  runVersion: number;
  approvedAt: string | null;
  workers: number;
}

export interface RunAdjustment {
  id: string;
  kind: "deduction" | "addition";
  inputMode: "amount" | "quantity";
  quantity: number | null;
  dayRate: number | null;
  amount: number;
  reason: string;
  createdAt: string;
  createdBy: string | null;
}

export interface RunWorker {
  runWorkerId: string;
  workerId: string | null;
  name: string;
  workerNumber: string | null;
  contractorName: string | null;
  siteId: string | null;
  siteName: string | null;
  unit: RateUnit;
  rate: number;
  currency: string;
  attendanceHours: number;
  attendanceDays: number;
  quantity: number | null;
  quantitySource: "attendance" | "manual";
  quantityNote: string | null;
  quantityAt: string | null;
  quantityBy: string | null;
  rowVersion: number;
  gross: number | null;
  policyLines: { name: string; kind: "deduction" | "addition"; calc: "fixed" | "percent"; value: number; amount: number }[];
  adjustments: RunAdjustment[];
  additions: number;
  deductions: number;
  net: number | null;
}

export interface RunDetail {
  run: {
    id: string;
    title: string;
    siteId: string | null;
    siteName: string | null;
    periodStart: string;
    periodEnd: string;
    status: "draft" | "approved";
    runVersion: number;
    approvedAt: string | null;
    approvedBy: string | null;
    reopenReason: string | null;
    rowVersion: number;
    isDraft: boolean;
  };
  rules: { dayRateBasis: string; fixedDivisor: number };
  workers: RunWorker[];
  totals: { currency: string; gross: number; additions: number; deductions: number; net: number; workers: number }[];
  can: { manage: boolean; adjust: boolean; approve: boolean; export: boolean };
}

class ExternalLaborRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  private async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const { data, error } = await this.client.rpc(fn, args);
      if (error) return { data: null, error: error.message };
      return { data: data as T, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "External labour pay is unavailable." };
    }
  }

  getSettings() {
    return this.call<ExternalSettings>("get_prosm_time_external_labor_settings");
  }
  saveSettings(dayRateBasis: string, fixedDivisor: number) {
    return this.call<ExternalSettings>("save_prosm_time_external_labor_settings", { p_day_rate_basis: dayRateBasis, p_fixed_divisor: fixedDivisor });
  }
  listRates() {
    return this.call<ExternalWorkerRates[]>("list_prosm_time_external_rates");
  }
  setRate(workerId: string, amount: number, currency: string, unit: RateUnit, effectiveFrom: string) {
    return this.call<{ rateId: string }>("set_prosm_time_external_rate", { p_worker_id: workerId, p_amount: amount, p_currency: currency, p_unit: unit, p_effective_from: effectiveFrom });
  }
  listPolicy() {
    return this.call<PolicyItem[]>("list_prosm_time_external_policy");
  }
  savePolicyItem(item: PolicyItem) {
    const { id, ...rest } = item;
    return this.call<{ id: string }>("save_prosm_time_external_policy_item", { p_id: id ?? null, p_item: rest });
  }
  listRuns() {
    return this.call<RunSummary[]>("list_prosm_time_external_runs");
  }
  createRun(periodStart: string, periodEnd: string, siteId: string | null, title: string | null) {
    return this.call<{ runId: string; added: number; skipped: { workerId: string; name: string; reason: "no_rate" | "in_other_run" }[] }>(
      "create_prosm_time_external_run",
      { p_period_start: periodStart, p_period_end: periodEnd, p_site_id: siteId, p_title: title },
    );
  }
  getRun(runId: string) {
    return this.call<RunDetail>("get_prosm_time_external_run", { p_run_id: runId });
  }
  setQuantity(runWorkerId: string, quantity: number, note: string | null, expectedVersion: number) {
    return this.call<{ success: boolean }>("set_prosm_time_external_quantity", { p_run_worker_id: runWorkerId, p_quantity: quantity, p_note: note, p_expected_version: expectedVersion });
  }
  addAdjustment(runWorkerId: string, kind: "deduction" | "addition", inputMode: "amount" | "quantity", value: number, reason: string) {
    return this.call<{ amount: number }>("add_prosm_time_external_adjustment", { p_run_worker_id: runWorkerId, p_kind: kind, p_input_mode: inputMode, p_value: value, p_reason: reason });
  }
  deleteAdjustment(adjustmentId: string) {
    return this.call<{ success: boolean }>("delete_prosm_time_external_adjustment", { p_adjustment_id: adjustmentId });
  }
  transition(runId: string, action: "approve" | "reopen" | "delete", reason: string | null, expectedVersion: number | null) {
    return this.call<{ success: boolean }>("transition_prosm_time_external_run", { p_run_id: runId, p_action: action, p_reason: reason, p_expected_version: expectedVersion });
  }
  logExport(runId: string, format: "pdf" | "xlsx", workerCount: number) {
    return this.call<{ draft: boolean }>("log_prosm_time_external_export", { p_run_id: runId, p_format: format, p_worker_count: workerCount });
  }
}

export default new ExternalLaborRepository();
