import type { TFunction } from "i18next";

import type { AmountType, PenaltyActionType, ViolationStatus } from "../../core/repositories/PenaltiesRepository";

// HR suite feature 1: one way to name a violation, a penalty and a state everywhere (page, profile, phone)

export const STATUS_BADGE: Record<ViolationStatus, string> = {
  pending_investigation: "pending",
  pending_response: "pending",
  pending_approval: "pending",
  approved: "active",
  reduced: "active",
  rejected: "revoked",
  appealed: "invited",
  cancelled: "deactivated",
  lapsed: "expired",
};

export const OPEN_STATUSES: ViolationStatus[] = ["pending_investigation", "pending_response", "pending_approval", "appealed"];

/** the violation's own name, or the suggested list's name in the reader's language */
export function violationName(t: TFunction, row: { violationName?: string | null; name?: string | null; templateKey?: string | null }): string {
  const own = row.violationName ?? row.name ?? null;
  if (own) return own;
  return row.templateKey ? t(`penalties:templates.${row.templateKey}`) : "—";
}

export function actionTypeName(t: TFunction, a: Pick<PenaltyActionType, "code" | "name"> | null | undefined): string {
  if (!a) return "—";
  return a.name ?? t(`penalties:actionCodes.${a.code}`);
}

const number = (n: number, language: string) => new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(n);

/** "Deduction - half a day" style: the penalty and its value */
export function actionText(t: TFunction, a: PenaltyActionType | null | undefined, language: string): string {
  if (!a) return "—";
  const name = actionTypeName(t, a);
  if (a.value == null || !a.unit) return name;
  return `${name} · ${t(`penalties:units.${a.unit}`, { count: Number(a.value), value: number(Number(a.value), language) })}`;
}

export function incentiveValueText(t: TFunction, type: AmountType, value: number, language: string): string {
  return t(`penalties:incentiveUnits.${type}`, { count: Number(value), value: number(Number(value), language) });
}

export function money(value: number | null | undefined, language: string): string {
  if (value == null) return "";
  return new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
}
