import type { jsPDF } from "jspdf";

import type { DashboardAuditRow } from "../../core/repositories/DashboardRepository";
import { escapeHtml, renderHtmlToPdf } from "../../core/utils/htmlToPdf";
import { auditLabel } from "../dashboard/manager/dashboardLogic";
import prosmLogo from "../../assets/prosm-logo-pdf.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// Owner 2026-10-28: the action log as shown (its filters applied), in the
// same certified layout as the other exports.
export function buildAuditLogPdf(
  rows: DashboardAuditRow[],
  from: string,
  to: string,
  languageCode: string,
  t: TFunc,
  when: (iso: string) => string,
  siteNames: Map<string, string>,
  organizationLogoUrl?: string | null,
): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const align = isRtl ? "right" : "left";
  const th = (label: string) => `<th style="padding:6px 8px;text-align:${align};font-size:10.5px;">${escapeHtml(label)}</th>`;
  const td = (value: string) => `<td style="padding:5px 8px;border-top:1px solid #e2e8f0;font-size:10px;">${escapeHtml(value)}</td>`;
  const body = rows
    .map((row) => `<tr>${[when(row.created_at), row.actor_name ?? t("manager.audit.system"), auditLabel(row.action, t), row.subject_name ?? "—", (row.site_id && siteNames.get(row.site_id)) || "—", row.reason ?? "—"].map(td).join("")}</tr>`)
    .join("");

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:780px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:16px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("auditPage.title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(from)} — ${escapeHtml(to)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${escapeHtml(organizationLogoUrl)}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f1f5f9;">${[t("manager.audit.columns.time"), t("manager.audit.columns.actor"), t("manager.audit.columns.action"), t("manager.audit.columns.subject"), t("manager.audit.columns.site"), t("manager.audit.columns.reason")].map(th).join("")}</tr></thead>
      <tbody>${body || `<tr><td colspan="6" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(t("manager.audit.empty"))}</td></tr>`}</tbody>
    </table>
  `;
  return renderHtmlToPdf(container);
}
