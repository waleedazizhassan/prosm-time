import type { DocumentStatus } from "../../core/repositories/DocumentsRepository";

// HR suite feature 2: one look for a document's state everywhere (profile tab, the follow-up page, the phone)
export const STATUS_BADGE: Record<DocumentStatus, string> = {
  valid: "active",
  expiring: "pending",
  expired: "expired",
  missing: "suspended",
  rejected: "revoked",
  pending_review: "invited",
  not_required: "neutral",
};

/** the badge text key and its count (days left / days since) */
export function statusText(status: DocumentStatus, daysLeft: number | null): { key: string; count?: number } {
  if (status === "expiring" && daysLeft !== null) return { key: daysLeft === 0 ? "state.expiresToday" : "state.expiresIn", count: daysLeft };
  if (status === "expired" && daysLeft !== null) return { key: "state.expiredAgo", count: Math.abs(daysLeft) };
  return { key: `status.${status}` };
}

export const NEEDS_ACTION: DocumentStatus[] = ["missing", "expired", "expiring", "rejected"];
