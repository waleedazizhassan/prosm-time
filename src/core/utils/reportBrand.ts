import i18next from "i18next";

import prosmFullLogo from "../../assets/brand/prosm-time-logo-pdf.png";
import prosmMark from "../../assets/brand/prosm-time-mark-pdf.png";
import { escapeHtml } from "./htmlToPdf";

// Owner 2026-11-09: every report belongs to the customer. Their logo leads the header; PROSM
// Time's full logo (with "WORK, TRACKED.") stays small; the footer says the document was issued
// through PROSM Time, beside the small mark. One place for all the PDF reports.

/** The customer's logo at the head of the report (nothing when the organisation has none). */
export function customerLogoHtml(logoUrl: string | null | undefined, height = 52): string {
  return logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" style="height:${height}px;max-width:${height * 3}px;object-fit:contain;" />`
    : `<div style="width:${height}px;"></div>`;
}

/** PROSM Time's full logo, small. */
export function prosmLogoHtml(height = 50): string {
  return `<img src="${prosmFullLogo}" alt="PROSM Time" style="height:${height}px;width:auto;object-fit:contain;" />`;
}

/** "Issued via PROSM Time" with the small mark, for the foot of every report. */
export function issuedViaHtml(): string {
  const words = i18next.t("common:issuedVia", { defaultValue: "Issued via" });
  return `<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;font-size:10px;color:#64748b;">
      <span>${escapeHtml(words)} <span dir="ltr">PROSM Time</span></span>
      <img src="${prosmMark}" alt="" style="height:13px;width:13px;object-fit:contain;" />
    </div>`;
}
