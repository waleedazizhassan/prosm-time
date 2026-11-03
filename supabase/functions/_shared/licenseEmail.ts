// Owner 2026-11-03: a licence change made in PROSM Platform Manager is emailed to each
// owner from support@prosm.net, with the new licence as a PDF.
// deno-lint-ignore-file no-explicit-any
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

import { buildLicencePdf, type LicencePdfData } from "./licensePdfCore.ts";

const FONT_REGULAR = "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoNaskhArabic/hinted/ttf/NotoNaskhArabic-Regular.ttf";
const FONT_BOLD = "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoNaskhArabic/hinted/ttf/NotoNaskhArabic-Bold.ttf";
const LOGO = "https://time.prosm.net/prosm-logo.png";

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
let logoCache: Uint8Array | null | undefined;

async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function base64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

const PLAN: Record<string, string> = { legacy: "كل المزايا", starter: "Starter", business: "Business", pro: "Pro" };
const STATUS: Record<string, string> = { ACTIVE: "فعّال", SUSPENDED: "موقوف", EXPIRED: "منتهٍ", REVOKED: "ملغى" };
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

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
}

export function licenceChanges(row: LicenceEmailRow): LicencePdfData["changes"] {
  const d = row.data ?? {};
  const v = (value: unknown) => (typeof value === "number" ? String(value) : "بلا حد");
  const changes: LicencePdfData["changes"] = [];
  if (d.usersChanged) changes.push({ label: "المستخدمون", from: v(d.usersFrom), to: v(d.usersTo) });
  if (d.devicesChanged) changes.push({ label: "الأجهزة", from: v(d.devicesFrom), to: v(d.devicesTo) });
  if (d.expiryChanged) changes.push({ label: "تاريخ الانتهاء", from: "—", to: typeof d.expiresAt === "string" ? d.expiresAt.slice(0, 10) : "بدون" });
  if (d.statusChanged) changes.push({ label: "الحالة", from: "—", to: STATUS[String(d.status)] ?? String(d.status ?? "") });
  if (d.planChanged) changes.push({ label: "الباقة", from: "—", to: PLAN[String(d.plan ?? row.plan)] ?? String(d.plan ?? row.plan) });
  return changes;
}

export async function renderLicenceEmail(row: LicenceEmailRow) {
  if (!fontCache) fontCache = { regular: await bytes(FONT_REGULAR), bold: await bytes(FONT_BOLD) };
  if (logoCache === undefined) logoCache = await bytes(LOGO).catch(() => null);
  const changes = licenceChanges(row);
  const pdf = await buildLicencePdf({ PDFDocument, StandardFonts, rgb, fontkit } as any, fontCache, logoCache, {
    organizationName: row.organizationName,
    licenseNumber: row.licenseNumber,
    plan: row.plan,
    status: row.status,
    maxUsers: row.maxUsers,
    activeUsers: row.activeUsers,
    maxDevices: row.maxDevices,
    expiresAt: row.expiresAt,
    changes,
    issuedAt: row.createdAt ?? new Date().toISOString(),
  });

  const list = changes.map((c) => `<li><b>${escape(c.label)}:</b> ${c.from === "—" ? "" : `${escape(c.from)} ← `}${escape(c.to)}</li>`).join("");
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;color:#1b2640;line-height:1.8">
  <p>أهلاً ${escape(row.name ?? "")}،</p>
  <p>عدّلت PROSM ترخيص <b>${escape(row.organizationName)}</b> في PROSM Time (رقم ${escape(row.licenseNumber)}):</p>
  <ul>${list || "<li>تحديث بيانات الترخيص.</li>"}</ul>
  <p>التعديل مطبّق الآن في البرنامج. مرفق الترخيص الجديد PDF، وتجده أيضاً في الإعدادات ← الاشتراك.</p>
  <p>لأي استفسار: <a href="mailto:support@prosm.net">support@prosm.net</a></p>
  <hr style="border:none;border-top:1px solid #e3e9f2">
  <p dir="ltr" style="text-align:left;color:#5b6b86;font-size:13px">PROSM changed your PROSM Time licence (${escape(row.licenseNumber)}). The new licence is attached and already applies.</p>
</div>`;
  return {
    to: row.to,
    subject: `PROSM Time — تعديل ترخيص ${row.organizationName}`,
    html,
    attachments: [{ name: `PROSM-Time-licence-${row.licenseNumber}.pdf`, contentBase64: base64(pdf) }],
  };
}
