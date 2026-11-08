import type { TFunction } from "i18next";

import humanizeBackendError from "../../core/utils/humanizeBackendError";

// 2026-11-08 B-07: the server's refusals for external labour pay, in the reader's language.
export function externalPayError(message: string | null | undefined, t: TFunction): string {
  if (!message) return t("externalPay:errors.generic");
  const known = humanizeBackendError(message, t);
  if (known && known !== message) return known;
  const codes: [RegExp, string][] = [
    [/EXTERNAL LABOR AUTHORITY REQUIRED/, "noAuthority"],
    [/FEATURE NOT IN PLAN/, "notInPlan"],
    [/CHANGED BY SOMEONE ELSE/, "changedBySomeoneElse"],
    [/REASON IS REQUIRED WHEN THE QUANTITY/, "quantityReason"],
    [/A REASON IS REQUIRED/, "reasonRequired"],
    [/REOPEN IT FIRST/, "approvedReopenFirst"],
    [/QUANTITY OF EVERY WORKER/, "quantitiesMissing"],
    [/AS AN AMOUNT/, "amountOnly"],
    [/INVALID CURRENCY|NEEDS A CURRENCY/, "currency"],
    [/GREATER THAN ZERO|INVALID QUANTITY/, "positive"],
    [/CANNOT EXCEED 100/, "percentMax"],
    [/NO WORKERS/, "noWorkers"],
    [/NEVER APPROVED/, "cannotDelete"],
  ];
  const hit = codes.find(([pattern]) => pattern.test(message));
  return hit ? t(`externalPay:errors.${hit[1]}`) : message;
}
