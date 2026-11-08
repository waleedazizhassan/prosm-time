import DatabaseManager from "../database/DatabaseManager";

// 2026-11-08: the payroll module (migrations 20261108130000, 20261108140000). Every rule -
// permissions and scope, the net, visibility of each line in each report, the workflow,
// snapshots and versions, publishing - is enforced by the server; this is only the transport.
// (PayrollRepository.ts stays the operational payroll export for accountants.)

export type CycleStatus = "draft" | "in_review" | "approved" | "locked" | "reopened" | "cancelled";
export type LineCategory = "earning" | "allowance" | "deduction" | "installment";
export type ReportType = "payslip" | "summary" | "combined";

export interface PayrollSettings {
  period_start_day: number;
  proration_policy: "none" | "calendar" | "working" | "fixed";
  proration_divisor: number;
  day_divisor: number;
  hours_per_day: number;
  overtime_multiplier: number;
  default_currency: string;
  allow_negative_net: boolean;
  net_change_warning_percent: number;
  employee_self_service: boolean;
  auto_lock_on_approve: boolean;
  report_language: "ar" | "en" | "bilingual";
  show_signatures: boolean;
  footer_note: string | null;
  tax_notice: string;
}

export interface PayrollComponent {
  id: string;
  name_ar: string;
  name_en: string | null;
  category: LineCategory;
  source: "fixed" | "variable";
  calc_type: "amount" | "percent";
  percent: number | null;
  percent_base: "basic" | "component" | "earnings" | null;
  base_component_id: string | null;
  is_basic: boolean;
  include_in_net: boolean;
  include_in_combined: boolean;
  prorate: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface CycleLine {
  id: string;
  component_id: string | null;
  name_ar: string;
  name_en: string | null;
  category: LineCategory;
  source: "fixed" | "variable" | "installment" | "attendance_suggestion" | "import";
  calc_type: "amount" | "percent";
  percent: number | null;
  is_basic: boolean;
  raw_amount: number;
  base_amount: number | null;
  amount: number;
  include_in_net: boolean;
  include_in_combined: boolean;
  notes: string | null;
  row_version: number;
  sort_order: number;
}

export interface CycleEmployee {
  id: string;
  user_id: string;
  site_id: string | null;
  full_name: string;
  employee_code: string | null;
  currency: string;
  has_profile: boolean;
  proration_factor: number;
  total_earnings: number;
  total_deductions: number;
  total_installments: number;
  net_salary: number;
  base_salary: number;
  total_allowances: number;
  combined_total: number;
  row_version: number;
  lines: CycleLine[];
}

export interface PayrollCycle {
  id: string;
  title: string;
  site_id: string | null;
  siteName?: string | null;
  period_start: string;
  period_end: string;
  status: CycleStatus;
  cycle_version: number;
  row_version: number;
  published_version: number | null;
  reopen_reason: string | null;
  cancel_reason: string | null;
}

export interface CycleSummary {
  id: string;
  title: string;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  status: CycleStatus;
  cycleVersion: number;
  rowVersion: number;
  publishedVersion: number | null;
  employees: number;
  totals: { currency: string; net: number }[];
}

export interface CycleCan {
  edit: boolean;
  enterVariables: boolean;
  review: boolean;
  approve: boolean;
  reopen: boolean;
  publish: boolean;
  exportPayslips: boolean;
  exportSummary: boolean;
  exportCombined: boolean;
  import: boolean;
}

export interface CycleDetail {
  cycle: PayrollCycle;
  can: CycleCan;
  employees: CycleEmployee[];
}

export interface ValidationItem {
  code: string;
  userId?: string;
  fullName?: string;
  [key: string]: unknown;
}

export interface Suggestion {
  cycleEmployeeId: string;
  userId: string;
  fullName: string;
  currency: string;
  kind: "unpaid_leave" | "late_minutes" | "overtime_minutes";
  quantity: number;
  unit: string;
  amount: number;
  accepted: boolean;
  changedSinceAccepted: boolean;
}

export interface PayrollReport {
  reportType: ReportType;
  serial: number | null;
  draft: boolean;
  cycle: { id: string; title: string; periodStart: string; periodEnd: string; status: CycleStatus; cycleVersion: number; siteName: string | null };
  organization: { name: string; logoUrl: string | null };
  settings: { taxNotice: string | null; footerNote: string | null; showSignatures: boolean; language: "ar" | "en" | "bilingual" };
  employees: CycleEmployee[];
  excluded: { userId: string; fullName: string; reason: string }[];
  totals: { currency: string; earnings: number; deductions: number; installments: number; net: number; base: number; allowances: number; combined: number; count: number }[];
}

export interface ProfileComponentValue {
  id: string;
  componentId: string;
  nameAr: string;
  nameEn: string | null;
  category: LineCategory;
  calcType: "amount" | "percent";
  amount: number | null;
  percent: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface PayrollPerson {
  userId: string;
  fullName: string;
  isActive: boolean;
  siteId: string | null;
  siteName: string | null;
  profile: { id: string; employee_code: string | null; currency: string; start_date: string | null; end_date: string | null; is_active: boolean; notes: string | null } | null;
  components: ProfileComponentValue[];
}

export interface InstallmentPlan {
  id: string;
  user_id: string;
  fullName: string;
  name: string;
  total_amount: number;
  installments_count: number;
  installment_amount: number;
  currency: string;
  start_period: string;
  status: "active" | "completed" | "cancelled";
  paid_amount: number;
  remaining: number;
  paidCount: number;
  row_version: number;
}

export interface MyPayslipCycle {
  cycleId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  cycleVersion: number;
  publishedAt: string;
  request: { id: string; status: "pending" | "sent" | "failed"; createdAt: string; sentAt: string | null; cycleVersion: number | null } | null;
}

export interface MyPayslip {
  cycle: { title: string; periodStart: string; periodEnd: string; cycleVersion: number };
  organization: { name: string; logoUrl: string | null };
  settings: { taxNotice: string | null; footerNote: string | null };
  employee: CycleEmployee;
}

export interface PayslipRequest {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  cycleId: string;
  cycleTitle: string;
  periodStart: string;
  periodEnd: string;
  status: "pending" | "sent" | "failed";
  sending: boolean;
  note: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  recipientEmail: string | null;
  cycleVersion: number | null;
  exportSerial: number | null;
  handledBy: string | null;
  cyclePublished: boolean;
}

export interface Result<T> {
  data: T | null;
  error: string | null;
}

class PayrollCycleRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  private async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const { data, error } = await this.client.rpc(fn, args);
      if (error) return { data: null, error: error.message };
      return { data: data as T, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "Payroll service unavailable." };
    }
  }

  // settings and components
  getSettings = () => this.call<PayrollSettings>("get_prosm_time_payroll_settings");
  saveSettings = (settings: Partial<PayrollSettings>) => this.call<{ success: boolean }>("save_prosm_time_payroll_settings", { p_settings: settings });
  listComponents = () => this.call<PayrollComponent[]>("list_prosm_time_payroll_components");
  saveComponent = (id: string | null, component: Partial<PayrollComponent>) =>
    this.call<{ id: string }>("save_prosm_time_payroll_component", { p_id: id, p_component: component });

  // profiles and installments
  listProfiles = () => this.call<PayrollPerson[]>("list_prosm_time_payroll_profiles");
  saveProfile = (userId: string, profile: Record<string, unknown>) => this.call<{ profileId: string }>("save_prosm_time_payroll_profile", { p_user_id: userId, p_profile: profile });
  setProfileComponent = (userId: string, componentId: string, amount: number | null, percent: number | null, effectiveFrom: string) =>
    this.call<{ id?: string }>("set_prosm_time_payroll_profile_component", { p_user_id: userId, p_component_id: componentId, p_amount: amount, p_percent: percent, p_effective_from: effectiveFrom });
  listInstallments = () => this.call<InstallmentPlan[]>("list_prosm_time_installment_plans");
  saveInstallment = (userId: string, name: string, total: number, count: number, startPeriod: string, installment: number | null) =>
    this.call<{ id: string }>("save_prosm_time_installment_plan", { p_user_id: userId, p_name: name, p_total: total, p_count: count, p_start_period: startPeriod, p_installment: installment });
  changeInstallment = (planId: string, action: "reschedule" | "settle" | "cancel", reason: string, installment: number | null, startPeriod: string | null, expectedVersion: number) =>
    this.call<{ success: boolean }>("change_prosm_time_installment_plan", { p_plan_id: planId, p_action: action, p_reason: reason, p_installment: installment, p_start_period: startPeriod, p_expected_version: expectedVersion });

  // cycles
  listCycles = () => this.call<CycleSummary[]>("list_prosm_time_payroll_cycles");
  createCycle = (periodStart: string, periodEnd: string, siteId: string | null, title: string | null) =>
    this.call<{ cycleId: string; employees: number; skipped: { userId: string; fullName: string; reason: string }[] }>("create_prosm_time_payroll_cycle", {
      p_period_start: periodStart, p_period_end: periodEnd, p_site_id: siteId, p_title: title,
    });
  getCycle = (cycleId: string) => this.call<CycleDetail>("get_prosm_time_payroll_cycle", { p_cycle_id: cycleId });
  recalculate = (cycleId: string, expectedVersion: number) => this.call<{ success: boolean }>("recalculate_prosm_time_payroll_cycle", { p_cycle_id: cycleId, p_expected_version: expectedVersion });
  saveLine = (cycleEmployeeId: string, lineId: string | null, componentId: string | null, amount: number, notes: string | null, expectedVersion: number | null, source = "variable", sourceRef: Record<string, unknown> | null = null) =>
    this.call<{ id: string }>("save_prosm_time_payroll_line", {
      p_cycle_employee_id: cycleEmployeeId, p_line_id: lineId, p_component_id: componentId, p_amount: amount, p_notes: notes,
      p_expected_version: expectedVersion, p_source: source, p_source_ref: sourceRef,
    });
  deleteLine = (lineId: string, expectedVersion: number) => this.call<{ success: boolean }>("delete_prosm_time_payroll_line", { p_line_id: lineId, p_expected_version: expectedVersion });
  suggestions = (cycleId: string) => this.call<Suggestion[]>("list_prosm_time_payroll_suggestions", { p_cycle_id: cycleId });
  validate = (cycleId: string) => this.call<{ errors: ValidationItem[]; warnings: ValidationItem[]; canSubmit: boolean }>("validate_prosm_time_payroll_cycle", { p_cycle_id: cycleId });
  transition = (cycleId: string, action: "submit" | "return" | "approve" | "lock" | "reopen" | "cancel", reason: string | null, expectedVersion: number | null, acknowledgeWarnings = false) =>
    this.call<{ status: CycleStatus }>("transition_prosm_time_payroll_cycle", {
      p_cycle_id: cycleId, p_action: action, p_reason: reason, p_expected_version: expectedVersion, p_acknowledge_warnings: acknowledgeWarnings,
    });
  publish = (cycleId: string, publish: boolean) => this.call<{ success: boolean }>("publish_prosm_time_payslips", { p_cycle_id: cycleId, p_publish: publish });
  report = (cycleId: string, reportType: ReportType, format: "preview" | "pdf" | "xlsx" | "zip", userIds: string[] | null = null) =>
    this.call<PayrollReport>("get_prosm_time_payroll_report", { p_cycle_id: cycleId, p_report_type: reportType, p_user_ids: userIds, p_site_ids: null, p_format: format });
  importLines = (cycleId: string, rows: Record<string, unknown>[], fileName: string, dryRun: boolean) =>
    this.call<{ rows: number; valid: number; errors: { row: number; code: string }[]; saved: boolean }>("import_prosm_time_payroll_lines", {
      p_cycle_id: cycleId, p_rows: rows, p_file_name: fileName, p_dry_run: dryRun,
    });

  // my payslips and the requests by email
  myPayslipCycles = () => this.call<{ canViewInApp: boolean; email: string | null; cycles: MyPayslipCycle[] }>("list_my_prosm_time_payslip_cycles");
  myPayslip = (cycleId: string) => this.call<MyPayslip>("get_my_prosm_time_payslip", { p_cycle_id: cycleId });
  requestPayslip = (cycleId: string, note: string | null) => this.call<{ id: string }>("request_prosm_time_payslip", { p_cycle_id: cycleId, p_note: note });
  listRequests = (status: string | null = null) => this.call<PayslipRequest[]>("list_prosm_time_payslip_requests", { p_status: status });

  /** One click: the server builds the PDF from the stored payslip and emails it (send-payslip-email). */
  async sendPayslip(requestId: string): Promise<Result<{ status: string; serial: number }>> {
    try {
      const { data, error } = await this.client.functions.invoke("send-payslip-email", { body: { requestId } });
      if (error) {
        let message = error.message;
        try {
          const body = await (error as { context?: Response }).context?.json();
          message = body?.error?.message ?? message;
        } catch {
          // the generic message stays
        }
        return { data: null, error: message };
      }
      return { data: data?.data ?? null, error: data?.success === false ? data?.error?.message ?? "Unable to send." : null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "Payroll service unavailable." };
    }
  }
}

export default new PayrollCycleRepository();
