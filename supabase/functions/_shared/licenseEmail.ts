// Owner 2026-11-03: a licence change made in PROSM Platform Manager is emailed to each
// owner (from the default noreply@ sender), with the new licence as a PDF - both in the
// owner's language, any of the app's nine.
// deno-lint-ignore-file no-explicit-any
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

import { buildLicencePdf, type LicencePdfData } from "./licensePdfCore.ts";
import { emailLanguage, emailLocale, emailT, isRtl } from "./emailI18n.ts";
import { base64, fontsFor, prosmLogo } from "./pdfFonts.ts";

// 2026-11-08: fonts, logo and base64 moved to pdfFonts.ts (shared with the payslip PDF).
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const PLAN_NAMES: Record<string, string> = { starter: "Starter", business: "Business", pro: "Pro", enterprise: "Enterprise" };
// the order of the plans sheet (as on the app's plan card)
const FEATURE_ROWS = [
  "sos", "announcements", "departments", "documents", "penalties", "leave", "scheduling", "allowances", "kiosk", "on_behalf", "clock_rules", "export", "payroll_export", "roles_manager",
  "payroll", "labor_cost", "audit", "roles_all", "clock_suggestion", "daily_summary", "manager_alerts",
  "integrations", "delegation", "retention",
];

/** The plan's row from the plans table (read by the sender). */
export interface LicencePlanInfo {
  featureFlags: Record<string, unknown> | null;
  maxSites: number | null;
  historyDays: number | null;
}

export interface LicenceEmailRow {
  organizationId: string;
  to: string;
  name: string;
  organizationName: string;
  licenseNumber: string;
  status: string;
  plan: string;
  maxUsers: number | null;
  maxDevices: number | null;
  activeUsers: number | null;
  expiresAt: string | null;
  data: Record<string, any>;
  createdAt: string;
  language?: string | null;
  planInfo?: LicencePlanInfo | null;
}

function words(language: string) {
  const T = (path: string, vars: Record<string, unknown> = {}) => emailT(language, path, vars);
  // Latin digits, like every other number on the page (an Arabic-Indic date would be drawn reversed).
  const date = (iso: string) => new Intl.DateTimeFormat(`${emailLocale(language)}-u-nu-latn`, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
  const plan = (key: string) => (key === "legacy" ? T("licence.pdf.planAll") : PLAN_NAMES[key] ?? key);
  const status = (key: string) => {
    const label = T(`licence.pdf.statuses.${key}`);
    return label.startsWith("licence.") ? key : label;
  };
  const limit = (value: unknown) => (typeof value === "number" ? String(value) : T("licence.pdf.unlimited"));
  return { T, date, plan, status, limit };
}

export function licenceChanges(row: LicenceEmailRow, language: string): LicencePdfData["changes"] {
  const { T, date, plan, status, limit } = words(language);
  const d = row.data ?? {};
  const changes: LicencePdfData["changes"] = [];
  if (d.usersChanged) changes.push({ label: T("licence.pdf.change.users"), from: limit(d.usersFrom), to: limit(d.usersTo) });
  if (d.devicesChanged) changes.push({ label: T("licence.pdf.change.devices"), from: limit(d.devicesFrom), to: limit(d.devicesTo) });
  if (d.expiryChanged) changes.push({ label: T("licence.pdf.change.expiry"), from: "", to: typeof d.expiresAt === "string" ? date(d.expiresAt) : T("licence.pdf.noEnd") });
  if (d.statusChanged) changes.push({ label: T("licence.pdf.change.status"), from: "", to: status(String(d.status ?? "")) });
  if (d.planChanged) changes.push({ label: T("licence.pdf.change.plan"), from: "", to: plan(String(d.plan ?? row.plan)) });
  return changes;
}

export function licencePdfData(row: LicenceEmailRow, language: string): LicencePdfData {
  const { T, date, plan, status } = words(language);
  const issued = (row.createdAt ?? new Date().toISOString()).slice(0, 16).replace("T", " ");
  return {
    rtl: isRtl(language),
    texts: {
      title: T("licence.pdf.title"),
      tagline: T("licence.pdf.tagline"),
      licenseNumber: T("licence.pdf.licenseNumber", { license: row.licenseNumber }),
      plan: T("licence.pdf.plan"),
      status: T("licence.pdf.status"),
      users: T("licence.pdf.users"),
      devices: T("licence.pdf.devices"),
      validUntil: T("licence.pdf.validUntil"),
      whatChanged: T("licence.pdf.whatChanged"),
      noChanges: T("licence.noChanges"),
      footer: T("licence.pdf.footer"),
      issued: T("licence.pdf.issued", { date: issued }),
    },
    organizationName: row.organizationName,
    planValue: plan(row.plan),
    statusValue: status(row.status),
    usersValue: row.maxUsers === null ? T("licence.pdf.unlimited") : row.activeUsers === null ? String(row.maxUsers) : T("licence.pdf.usersOf", { used: row.activeUsers, max: row.maxUsers }),
    devicesValue: row.maxDevices === null ? T("licence.pdf.unlimited") : String(row.maxDevices),
    validUntilValue: row.expiresAt ? date(row.expiresAt) : T("licence.pdf.noEnd"),
    changes: licenceChanges(row, language),
    includes: planIncludes(row.planInfo ?? null, language),
  };
}

// Owner 2026-11-10: the certificate lists what the plan includes, like the plan card in Settings.
export function planIncludes(info: LicencePlanInfo | null, language: string): LicencePdfData["includes"] {
  if (!info) return null;
  const { T } = words(language);
  const flags = info.featureFlags ?? {};
  // a right-to-left PDF line cannot show brackets and guillemets the right way round: "X (Y)" reads "X - Y"
  const plain = (text: string) => (isRtl(language) ? text.replace(/\s*\(([^)]*)\)/g, " - $1").replace(/[«»]/g, "") : text);
  const features = FEATURE_ROWS.filter((key) => flags[key] === true).map((key) => plain(T(`licence.pdf.features.${key}`)));
  const sites = typeof info.maxSites === "number" ? T("licence.pdf.sitesUpTo", { count: info.maxSites }) : T("licence.pdf.sitesAll");
  const history = info.historyDays ? T("licence.pdf.history", { count: Math.round(info.historyDays / 365) }) : T("licence.pdf.historyAll");
  return { title: T("licence.pdf.includes"), summary: [plain(`${sites} · ${history}`), plain(T("licence.pdf.always"))], features };
}

export async function renderLicenceEmail(row: LicenceEmailRow) {
  const language = emailLanguage(row.language);
  const { T } = words(language);
  const data = licencePdfData(row, language);
  const pageTexts = [data.organizationName, ...Object.values(data.texts), data.planValue, data.statusValue, data.usersValue, data.devicesValue, data.validUntilValue, ...data.changes.flatMap((c) => [c.label, c.from, c.to]), ...(data.includes ? [data.includes.title, ...data.includes.summary, ...data.includes.features] : [])];
  const fonts = await fontsFor(pageTexts);
  const logo = await prosmLogo();
  const pdf = await buildLicencePdf({ PDFDocument, rgb, fontkit } as any, fonts, logo, data);

  const rtl = isRtl(language);
  const arrow = rtl ? "←" : "→";
  const list = data.changes
    .map((c) => `<li><b>${escape(c.label)}:</b> ${c.from ? `${escape(c.from)} ${arrow} ` : ""}${escape(c.to)}</li>`)
    .join("");
  const html = `<div dir="${rtl ? "rtl" : "ltr"}" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;color:#1b2640;line-height:1.8;text-align:${rtl ? "right" : "left"}">
  <p>${escape(T("licence.greeting", { name: row.name ?? "" }))}</p>
  <p>${escape(T("licence.intro", { org: row.organizationName, license: row.licenseNumber }))}</p>
  <ul>${list || `<li>${escape(T("licence.noChanges"))}</li>`}</ul>
  <p>${escape(T("licence.applied"))}</p>
  <p>${escape(T("licence.contact"))} <a href="mailto:support@prosm.net">support@prosm.net</a></p>
  <hr style="border:none;border-top:1px solid #e3e9f2">
  <p style="color:#5b6b86;font-size:13px">${escape(T("common.signature"))}</p>
</div>`;
  return {
    to: row.to,
    subject: T("licence.subject", { org: row.organizationName }),
    html,
    attachments: [{ name: `PROSM-Time-licence-${row.licenseNumber}.pdf`, contentBase64: base64(pdf) }],
  };
}
