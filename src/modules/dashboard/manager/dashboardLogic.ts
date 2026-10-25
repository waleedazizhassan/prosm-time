// v2.3.43 step 17: the dashboard's pure rules, kept apart so they are tested.

export type Period = "day" | "week" | "month" | "custom";
export type WidgetId = "map" | "present" | "sites" | "approvals" | "people" | "chart" | "cost" | "audit";
export const DEFAULT_ORDER: WidgetId[] = ["map", "present", "sites", "approvals", "people", "chart", "cost", "audit"];

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
const AUDIT_NAMED = new Set(["SOS_ALERT_TRIGGERED", "SOS_ALERT_RESOLVED", "ADMIN_CLOCK_IN_ON_BEHALF", "ADMIN_CLOCK_OUT_ON_BEHALF", "PERMISSION_GRANTED", "PERMISSION_REVOKED", "EMPLOYEE_DEACTIVATED", "EMPLOYEE_REMOVED", "USER_INVITED", "attendance.override_block", "attendance.day_adjusted", "attendance.overtime_approved", "attendance.auto_close", "allowances.edit_during_review", "leave.approved_cancelled"]);
const AUDIT_GROUPS: [RegExp, string][] = [
  [/^SOS_/, "sos"],
  [/CLOCK|^attendance\.|^PRESENCE_|^offline\./, "attendance"],
  [/^SITE|^sites?\./, "sites"],
  [/^PERMISSION_/, "permissions"],
  [/^leave\./, "leave"],
  [/ALLOWANCE|^allowances\.|PAY_RATE/, "allowances"],
  [/^calendar\./, "calendar"],
  [/^PROJECT_/, "projects"],
  [/^USER_|^EMPLOYEE_|^employees\.|^PASSWORD_|^EXTERNAL_WORKER/, "people"],
  [/^DEVICE_|^CAMERA_|^KIOSK_PIN/, "devices"],
  [/^settings\.|^schedules\.|^ORGANIZATION_|^LICENSE_|^API_KEY|_DISCONNECTED$/, "settings"],
];

export function auditLabel(action: string, t: (key: string) => string): string {
  if (AUDIT_NAMED.has(action)) return t(`manager.audit.named.${action.replace(/\./g, "_")}`);
  const group = AUDIT_GROUPS.find(([pattern]) => pattern.test(action))?.[1] ?? "other";
  return t(`manager.audit.groups.${group}`);
}
