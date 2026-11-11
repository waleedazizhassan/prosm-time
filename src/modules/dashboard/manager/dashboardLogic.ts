// v2.3.43 step 17: the dashboard's pure rules, kept apart so they are tested.

export type Period = "day" | "week" | "month" | "custom";
export type WidgetId = "map" | "present" | "sites" | "approvals" | "external" | "people" | "chart" | "insights" | "cost" | "audit";
export const DEFAULT_ORDER: WidgetId[] = ["map", "present", "sites", "approvals", "external", "people", "chart", "insights", "cost", "audit"];

export function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The week runs Sunday to Saturday (owner 2026-10-19), as on the overview card.
export function periodRange(period: Period, custom: { from: string; to: string }, now: Date = new Date()): { from: string; to: string } {
  if (period === "day") return { from: iso(now), to: iso(now) };
  if (period === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: iso(start), to: iso(end) };
  }
  if (period === "month") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  return custom.from && custom.to ? custom : { from: iso(now), to: iso(now) };
}

export function trend(current: number, previous: number | null | undefined, lowerIsBetter = false) {
  if (previous === null || previous === undefined || previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  const good = lowerIsBetter ? change <= 0 : change >= 0;
  return { change, good };
}

// A saved order keeps only known widgets and gains any new ones at the end.
export function mergeOrder(saved: WidgetId[]): WidgetId[] {
  const known = saved.filter((id) => DEFAULT_ORDER.includes(id));
  return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
}

// The audit log speaks the reader's language: a few key actions by name,
// every other one by its kind (the server's own text is English).
const AUDIT_NAMED = new Set(["SOS_ALERT_TRIGGERED", "SOS_ALERT_RESOLVED", "ADMIN_CLOCK_IN_ON_BEHALF", "ADMIN_CLOCK_OUT_ON_BEHALF", "PERMISSION_GRANTED", "PERMISSION_REVOKED", "EMPLOYEE_DEACTIVATED", "EMPLOYEE_REMOVED", "USER_INVITED", "attendance.override_block", "attendance.day_adjusted", "attendance.overtime_approved", "attendance.auto_close", "allowances.edit_during_review", "leave.approved_cancelled", "hr.profile_changed", "hr.contract_saved", "hr.contract_deleted", "hr.job_title_saved"]);
// Owner 2026-11-10 ("the action log has many things that are not clear"): the automatic records of a
// table change ("<table>.<insert|update|delete>") and the newer actions get their own kind, not "other".
const AUDIT_GROUPS: [RegExp, string][] = [
  [/^SOS_|^sos_alerts\./, "sos"],
  [/CLOCK|^attendance\.|^PRESENCE_|^offline\.|^timesheet_|^exception_actions\.|^presence_sessions\./, "attendance"],
  [/^SITE|^sites?\.|^site_checklist_items\.|^site_assignments\./, "sites"],
  [/^schedule\.|^shift_|^open_shift/, "schedule"],
  [/^PERMISSION_|^OWNER_AUTHORITY_|^owner_delegations\.|^user_permission_overrides\./, "permissions"],
  [/^leave/, "leave"],
  [/ALLOWANCE|^allowances?[._]|PAY_RATE|^worker_pay_rates\./, "allowances"],
  [/^payroll|^EXTERNAL_PAY_|^EXTERNAL_LABOR_|^external_labor_/, "payroll"],
  [/^calendar\.|^public_holidays\.|^schedule_exceptions\./, "calendar"],
  [/^PROJECT_|^project_assignments\./, "projects"],
  [/^USER_|^EMPLOYEE_|^employees\.|^PASSWORD_|^EXTERNAL_WORKER|^ACCOUNT_|^site_workers\.|^hr\./, "people"],
  [/^DEVICE_|^CAMERA_|^KIOSK_PIN|^device\.|^security\.|^camera_evidence\.|^integrity_flags\./, "devices"],
  [/^ANNOUNCEMENT_|^DEPARTMENT_/, "announcements"],
  [/^report_exports\./, "reports"],
  [/^settings\.|^schedules\.|^ORGANIZATION_|^LICENSE_|^API_KEY|_DISCONNECTED$|^WEBHOOK_|^license\.|^retention\.|^organization_settings\.|^entitlements\./, "settings"],
];

// the tables whose changes are recorded automatically, by name
const ROW_CHANGE_TABLES = new Set(["timesheet_approvals", "timesheet_corrections", "exception_actions", "leave_entitlements", "site_workers", "shift_templates", "shift_assignments", "open_shifts", "open_shift_requests", "allowance_categories", "allowance_category_members", "site_checklist_items", "payroll_export_templates", "organization_settings", "sites", "report_exports", "entitlements"]);

// owner 2026-10-28: the action log page filters by kind on the server with these same patterns
export const AUDIT_GROUP_PATTERNS: Record<string, string> = Object.fromEntries(AUDIT_GROUPS.map(([pattern, group]) => [group, pattern.source]));

// owner 2026-10-28: the action log has its own page; on the dashboard its card shows only when chosen
export const DEFAULT_HIDDEN: WidgetId[] = ["audit"];

export function auditLabel(action: string, t: (key: string) => string): string {
  if (AUDIT_NAMED.has(action)) return t(`manager.audit.named.${action.replace(/\./g, "_")}`);
  // "shift_templates.insert" -> "Shift template · added"; an export is just "Report exported"
  const row = /^([a-z_]+)\.(insert|update|delete)$/.exec(action);
  if (row && ROW_CHANGE_TABLES.has(row[1])) {
    if (row[1] === "report_exports") return t("manager.audit.table.report_exports");
    return `${t(`manager.audit.table.${row[1]}`)} · ${t(`manager.audit.op.${row[2]}`)}`;
  }
  const group = AUDIT_GROUPS.find(([pattern]) => pattern.test(action))?.[1] ?? "other";
  return t(`manager.audit.groups.${group}`);
}
