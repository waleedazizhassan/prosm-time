// Owner 2026-11-03: every licence change made in PROSM Platform Manager reaches the owner
// by email with the new licence as a PDF. The page itself, independent of where it runs
// (the Edge Function passes pdf-lib and fontkit in). Arabic is drawn by fontkit, which
// joins the letters and lays a right-to-left run out itself; a line that mixes Arabic with
// numbers or Latin is cut into runs, each drawn in its own font, from the right.
// deno-lint-ignore-file no-explicit-any

export interface LicencePdfData {
  organizationName: string;
  licenseNumber: string;
  plan: string;
  status: string;
  maxUsers: number | null;
  activeUsers: number | null;
  maxDevices: number | null;
  expiresAt: string | null;
  changes: { label: string; from: string; to: string }[];
  issuedAt: string;
}

export interface PdfLibs {
  PDFDocument: any;
  StandardFonts: any;
  rgb: (r: number, g: number, b: number) => any;
  fontkit: any;
}

const ARABIC_CHAR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
// An Arabic run keeps the spaces and Arabic punctuation between its words.
const RUNS = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+(?:[\s،؛]+[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+)*|[^؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g;

const PLAN_NAMES: Record<string, string> = { legacy: "كل المزايا", starter: "Starter", business: "Business", pro: "Pro" };
const STATUS: Record<string, string> = { ACTIVE: "فعّال", SUSPENDED: "موقوف", EXPIRED: "منتهٍ", REVOKED: "ملغى" };

export async function buildLicencePdf(libs: PdfLibs, fonts: { regular: Uint8Array; bold: Uint8Array }, logoPng: Uint8Array | null, data: LicencePdfData): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, fontkit } = libs;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`PROSM Time licence ${data.licenseNumber}`);
  doc.setAuthor("PROSM");
  const ar = { regular: await doc.embedFont(fonts.regular, { subset: true }), bold: await doc.embedFont(fonts.bold, { subset: true }) };
  const la = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const page = doc.addPage([595.28, 841.89]);
  const W = page.getWidth();
  const H = page.getHeight();
  const navy = rgb(0.04, 0.12, 0.27);
  const blue = rgb(0.11, 0.44, 0.88);
  const green = rgb(0.12, 0.75, 0.42);
  const ink = rgb(0.11, 0.15, 0.25);
  const muted = rgb(0.36, 0.42, 0.53);
  const line = rgb(0.89, 0.91, 0.95);
  const soft = rgb(0.95, 0.97, 0.99);
  const white = rgb(1, 1, 1);
  const margin = 44;

  type Weight = "regular" | "bold";
  // In a right-to-left line, the spaces and marks a Latin run starts or ends with sit on
  // the Arabic side: "رقم الترخيص: X" shows as "X :رقم الترخيص".
  const flip = (run: string) => {
    const match = run.match(/^([\s:.,;!?\-]*)([\s\S]*?)([\s:.,;!?\-]*)$/);
    if (!match) return run;
    const [, lead, core, trail] = match;
    return [...trail].reverse().join("") + core + [...lead].reverse().join("");
  };
  const runsOf = (text: string) => {
    const runs = (text.match(RUNS) ?? [text]).map((run) => ({ run, arabic: ARABIC_CHAR.test(run) }));
    if (!runs.some((r) => r.arabic)) return runs;
    return runs.map((r) => (r.arabic ? r : { run: flip(r.run), arabic: false }));
  };
  const widthOf = (text: string, size: number, weight: Weight) =>
    runsOf(text).reduce((sum, { run, arabic }) => sum + (arabic ? ar : la)[weight].widthOfTextAtSize(arabic ? run : run.replace(/[^\x20-\x7E -ÿ]/g, "?"), size), 0);
  // Draws a line whose right edge is at x: Arabic lines read from the right.
  const drawRight = (text: string, xRight: number, y: number, size: number, weight: Weight = "regular", color = ink) => {
    let x = xRight;
    for (const { run, arabic } of runsOf(text)) {
      const font = (arabic ? ar : la)[weight];
      const shown = arabic ? run : run.replace(/[^\x20-\x7E -ÿ]/g, "?");
      const w = font.widthOfTextAtSize(shown, size);
      x -= w;
      page.drawText(shown, { x, y, size, font, color });
    }
  };
  const drawLeft = (text: string, xLeft: number, y: number, size: number, weight: Weight = "regular", color = ink) =>
    drawRight(text, xLeft + widthOf(text, size, weight), y, size, weight, color);

  // header band
  page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: navy });
  page.drawRectangle({ x: 0, y: H - 154, width: W * 0.62, height: 4, color: blue });
  page.drawRectangle({ x: W * 0.62, y: H - 154, width: W * 0.38, height: 4, color: green });
  if (logoPng) {
    const logo = await doc.embedPng(logoPng);
    const h = 108;
    page.drawImage(logo, { x: margin - 6, y: H - 132, width: (logo.width / logo.height) * h, height: h });
  }
  drawRight("شهادة ترخيص PROSM Time", W - margin, H - 66, 24, "bold", white);
  drawRight("PROSM Time licence certificate", W - margin, H - 92, 12, "regular", rgb(0.8, 0.86, 0.95));
  drawRight("حضور تثق فيه، في الموقع وفي الوقت.", W - margin, H - 118, 11, "regular", rgb(0.55, 0.92, 0.7));

  // the licence
  let y = H - 200;
  drawRight(data.organizationName, W - margin, y, 20, "bold", navy);
  y -= 22;
  drawRight(`رقم الترخيص: ${data.licenseNumber}`, W - margin, y, 11, "regular", muted);
  y -= 30;

  const unlimited = "بلا حد";
  const rows: [string, string, string][] = [
    ["الباقة", "Plan", PLAN_NAMES[data.plan] ?? data.plan],
    ["الحالة", "Status", STATUS[data.status] ?? data.status],
    ["المستخدمون", "Users", data.maxUsers === null ? unlimited : data.activeUsers === null ? String(data.maxUsers) : `${data.activeUsers} / ${data.maxUsers}`],
    ["الأجهزة", "Devices", data.maxDevices === null ? unlimited : String(data.maxDevices)],
    ["ينتهي في", "Valid until", data.expiresAt ? data.expiresAt.slice(0, 10) : "بدون تاريخ انتهاء"],
  ];
  const rowH = 34;
  page.drawRectangle({ x: margin, y: y - rows.length * rowH + 8, width: W - margin * 2, height: rows.length * rowH, color: soft, borderColor: line, borderWidth: 1 });
  rows.forEach(([arLabel, enLabel, value], index) => {
    drawRight(arLabel, W - margin - 14, y - 14, 12.5, "bold", navy);
    drawRight(enLabel, W - margin - 130, y - 14, 9, "regular", muted);
    drawLeft(value, margin + 16, y - 14, 13, "bold", ink);
    y -= rowH;
    if (index < rows.length - 1) page.drawLine({ start: { x: margin + 10, y: y + 8 }, end: { x: W - margin - 10, y: y + 8 }, thickness: 0.6, color: line });
  });

  // what changed
  y -= 26;
  drawRight("ما الذي تغيّر", W - margin, y, 15, "bold", blue);
  drawLeft("What changed", margin, y, 10, "regular", muted);
  y -= 10;
  for (const change of data.changes) {
    y -= 26;
    page.drawCircle({ x: W - margin - 6, y: y + 4, size: 3.2, color: green });
    drawRight(change.label, W - margin - 16, y, 12, "bold", ink);
    // reads from the right: before, then the arrow, then after
    drawLeft(`${change.to}`, margin + 16, y, 12, "bold", ink);
    const toWidth = widthOf(change.to, 12, "bold");
    drawLeft("<-", margin + 24 + toWidth, y, 11, "regular", muted);
    drawLeft(`${change.from}`, margin + 44 + toWidth, y, 12, "regular", muted);
  }
  if (data.changes.length === 0) {
    y -= 26;
    drawRight("تحديث بيانات الترخيص.", W - margin - 16, y, 12, "regular", ink);
  }

  // footer
  page.drawRectangle({ x: 0, y: 0, width: W, height: 70, color: soft });
  page.drawLine({ start: { x: 0, y: 70 }, end: { x: W, y: 70 }, thickness: 0.8, color: line });
  drawRight("صادرة آليًا من PROSM عند تعديل الترخيص. للاستفسار: support@prosm.net", W - margin, 42, 10, "regular", muted);
  drawLeft(`Issued ${data.issuedAt.slice(0, 16).replace("T", " ")} UTC  -  time.prosm.net`, margin, 22, 9, "regular", muted);

  return await doc.save();
}
