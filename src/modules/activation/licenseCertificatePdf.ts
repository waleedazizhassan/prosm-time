import type { jsPDF } from "jspdf";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

export interface LicenseCertificateData {
  organizationName: string;
  organizationCode: string;
  ownerFullName: string;
  ownerEmail: string;
  licenseNumber: string;
  status: string;
  maxUsers: number | null;
  maxDevices: number | null;
  expiresAt: string | null;
  activatedAt: string;
}

// PROSM Time - § live UX review, user-directed: "after pressing
// Activate, automatically download the license with the data, with
// the PROSM logo, the organization's logo, and the app name PROSM
// Time on it." Same certified-document shell (html2canvas via
// renderHtmlToPdf) every other PDF in this app already uses - the
// org's own logo is whatever was just uploaded during activation
// (may be null if the Owner skipped that field).
export function buildLicenseCertificatePdf(data: LicenseCertificateData, languageCode: string, t: TFunc, organizationLogoUrl: string | null): Promise<jsPDF> {
  const isRtl = languageCode === "ar";

  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 12px;color:#64748b;white-space:nowrap;border-top:1px solid #e2e8f0;">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-weight:600;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(value)}</td>
    </tr>`;

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:780px;padding:44px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:20px;margin-bottom:24px;">
      <img src="${prosmLogo}" style="height:52px;width:52px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:22px;font-weight:700;">${escapeHtml(t("common:appName"))}</div>
        <div style="font-size:13px;color:#64748b;margin-top:4px;">${escapeHtml(t("activation.certificate.title"))}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${organizationLogoUrl}" style="height:52px;max-width:96px;object-fit:contain;" />` : `<div style="width:52px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${row(t("activation.certificate.organization"), `${data.organizationName} (${data.organizationCode})`)}
      ${row(t("activation.certificate.owner"), `${data.ownerFullName} (${data.ownerEmail})`)}
      ${row(t("activation.certificate.licenseNumber"), data.licenseNumber)}
      ${row(t("activation.certificate.status"), data.status)}
      ${row(t("activation.certificate.maxUsers"), data.maxUsers != null ? String(data.maxUsers) : "—")}
      ${row(t("activation.certificate.maxDevices"), data.maxDevices != null ? String(data.maxDevices) : "—")}
      ${row(t("activation.certificate.expiresAt"), data.expiresAt ?? t("activation.certificate.noExpiry"))}
      ${row(t("activation.certificate.activatedAt"), data.activatedAt)}
    </table>

    <p style="margin-top:28px;font-size:11px;color:#94a3b8;text-align:center;">${escapeHtml(t("activation.certificate.footer"))}</p>
  `;

  return renderHtmlToPdf(container);
}
