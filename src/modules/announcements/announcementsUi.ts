import type { TFunction } from "i18next";

import humanizeBackendError from "../../core/utils/humanizeBackendError";

// 2026-11-09 Media Center: the server's refusals in the reader's language.
const CODES: [RegExp, string][] = [
  [/NOT ALLOWED TO PUBLISH/, "notAllowed"],
  [/NOT ALLOWED TO EDIT THIS ANNOUNCEMENT/, "notYours"],
  [/NOT ALLOWED TO SEE WHO READ/, "noReads"],
  [/NOT ALLOWED TO MANAGE DEPARTMENTS/, "noDepartments"],
  [/ORGANISATION-WIDE/, "orgWideOnly"],
  [/SITES YOU MANAGE/, "ownSitesOnly"],
  [/PEOPLE AT THE SITES/, "ownPeopleOnly"],
  [/CHOOSE AT LEAST ONE/, "chooseAudience"],
  [/A TITLE IS REQUIRED/, "titleRequired"],
  [/TEXT IS TOO LONG/, "tooLong"],
  [/EXPIRY MUST BE IN THE FUTURE/, "expiryPast"],
  [/EXPIRY MUST BE AFTER/, "expiryBeforePublish"],
  [/CANNOT BE EDITED|ALREADY PUBLISHED/, "published"],
  [/A REASON IS REQUIRED/, "reasonRequired"],
  [/ONLY A DRAFT/, "draftOnly"],
  [/REMOVE THE FILES FIRST/, "removeFiles"],
  [/FULL WEB ADDRESS/, "badUrl"],
  [/AT MOST 20 ATTACHMENTS/, "tooManyAttachments"],
  [/FILE TYPE IS NOT ACCEPTED/, "fileType"],
  [/LARGER THAN 10 MB/, "fileTooLarge"],
  [/MEDIA SERVICE|UPLOAD FAILED|UNABLE TO OPEN|SIGN/, "mediaUnavailable"],
  [/DEPARTMENT WITH THIS NAME/, "departmentExists"],
  [/DEPARTMENT NAME IS REQUIRED/, "departmentName"],
  [/NOT FOUND/, "notFound"],
];

export function announcementError(message: string | null | undefined, t: TFunction): string {
  if (!message) return t("announcements:errors.generic");
  for (const [pattern, key] of CODES) if (pattern.test(message)) return t(`announcements:errors.${key}`);
  return humanizeBackendError(message, t) ?? t("announcements:errors.generic");
}

export function fileSize(bytes: number | null): string {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// a "YYYY-MM-DDTHH:mm" local value (DateTimeInput) as an ISO moment, and back
export const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
export function toLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
