// Owner 2026-11-03: every licence change made in PROSM Platform Manager reaches the owner
// by email with the new licence as a PDF, in the owner's language (any of the app's nine).
// The page itself, independent of where it runs (the Edge Function passes pdf-lib and fontkit
// in, and the texts already in the language). Each line is cut into script runs - Arabic,
// Chinese, and the rest (Latin, Cyrillic, digits) - each drawn in its own font; fontkit joins
// Arabic letters and lays an Arabic run out right to left itself. An Arabic page reads from
// the right, the others from the left.
// deno-lint-ignore-file no-explicit-any

export interface LicencePdfTexts {
  title: string;
  tagline: string;
  licenseNumber: string;
  plan: string;
  status: string;
  users: string;
  devices: string;
  validUntil: string;
  whatChanged: string;
  noChanges: string;
  footer: string;
  issued: string;
}

export interface LicencePdfData {
  rtl: boolean;
  texts: LicencePdfTexts;
  organizationName: string;
  planValue: string;
  statusValue: string;
  usersValue: string;
  devicesValue: string;
  validUntilValue: string;
  /** from is "" when there is nothing before (a new end date, a status). */
  changes: { label: string; from: string; to: string }[];
  /** Owner 2026-11-10: what the plan includes - shown under the changes when known. */
  includes?: { title: string; summary: string[]; features: string[] } | null;
}

export interface PdfLibs {
  PDFDocument: any;
  rgb: (r: number, g: number, b: number) => any;
  fontkit: any;
}

/** presubset: already cut down to the page's characters (see fontSubset.ts), so embedded whole. */
type Pair = { regular: Uint8Array; bold: Uint8Array; presubset?: boolean };
export interface LicencePdfFonts {
  /** Latin, Cyrillic, Greek, digits (Noto Sans). */
  latin: Pair;
  /** Needed only when a text has Arabic letters (Noto Naskh Arabic). */
  arabic?: Pair | null;
  /** Needed only when a text has Chinese characters (Noto Sans SC, presubset). */
  cjk?: Pair | null;
}

import { runsOf, scriptsNeeded } from "./pdfText.ts";

// 2026-11-08: the script runs and font needs moved to pdfText.ts (shared with the payslip PDF).
export { scriptsNeeded };

export async function buildLicencePdf(libs: PdfLibs, fonts: LicencePdfFonts, logoPng: Uint8Array | null, data: LicencePdfData): Promise<Uint8Array> {
  const { PDFDocument, rgb, fontkit } = libs;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(data.texts.title);
  doc.setAuthor("PROSM");
  const embed = async (pair: Pair) => ({
    regular: await doc.embedFont(pair.regular, { subset: !pair.presubset }),
    bold: await doc.embedFont(pair.bold, { subset: !pair.presubset }),
  });
  const latin = await embed(fonts.latin);
  const arabic = fonts.arabic ? await embed(fonts.arabic) : latin;
  const cjk = fonts.cjk ? await embed(fonts.cjk) : latin;
  const fontFor = { latin, arabic, cjk };

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
  const rtl = data.rtl;

  type Weight = "regular" | "bold";
  // In a right-to-left line, the spaces and marks a left-to-right run starts or ends with sit
  // on the Arabic side: "رقم الترخيص: X" shows as "X :رقم الترخيص".
  const flip = (run: string) => {
    const match = run.match(/^([\s:.,;!?\-]*)([\s\S]*?)([\s:.,;!?\-]*)$/);
    if (!match) return run;
    const [, lead, core, trail] = match;
    return [...trail].reverse().join("") + core + [...lead].reverse().join("");
  };
  const laidOut = (text: string) => {
    const runs = runsOf(text);
    if (!rtl || !runs.some((r) => r.script === "arabic")) return runs;
    return runs.map((r) => (r.script === "arabic" ? r : { ...r, run: flip(r.run) }));
  };
  const widthOf = (text: string, size: number, weight: Weight) =>
    laidOut(text).reduce((sum, { run, script }) => sum + fontFor[script][weight].widthOfTextAtSize(run, size), 0);
  const drawFrom = (text: string, xLeft: number, y: number, size: number, weight: Weight, color: any) => {
    const runs = laidOut(text);
    let x = xLeft;
    // A right-to-left page puts the first run at the right end of the line.
    for (const { run, script } of rtl ? [...runs].reverse() : runs) {
      const font = fontFor[script][weight];
      page.drawText(run, { x, y, size, font, color });
      x += font.widthOfTextAtSize(run, size);
    }
  };
  const drawLeft = (text: string, xLeft: number, y: number, size: number, weight: Weight = "regular", color = ink) => drawFrom(text, xLeft, y, size, weight, color);
  const drawRight = (text: string, xRight: number, y: number, size: number, weight: Weight = "regular", color = ink) =>
    drawFrom(text, xRight - widthOf(text, size, weight), y, size, weight, color);
  // "start" is the side a line begins on: the right on an Arabic page, the left otherwise.
  const drawStart = (text: string, inset: number, y: number, size: number, weight: Weight = "regular", color = ink) =>
    rtl ? drawRight(text, W - inset, y, size, weight, color) : drawLeft(text, inset, y, size, weight, color);
  const drawEnd = (text: string, inset: number, y: number, size: number, weight: Weight = "regular", color = ink) =>
    rtl ? drawLeft(text, inset, y, size, weight, color) : drawRight(text, W - inset, y, size, weight, color);
  const textWidth = (maxWidth: number, text: string, size: number, weight: Weight) => {
    // Shrinks a long name so it stays on one line.
    let s = size;
    while (s > 8 && widthOf(text, s, weight) > maxWidth) s -= 0.5;
    return s;
  };

  // header band: the logo on the end side, the title on the start side
  page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: navy });
  page.drawRectangle({ x: 0, y: H - 154, width: W * 0.62, height: 4, color: blue });
  page.drawRectangle({ x: W * 0.62, y: H - 154, width: W * 0.38, height: 4, color: green });
  let logoWidth = 0;
  if (logoPng) {
    const logo = await doc.embedPng(logoPng);
    const h = 108;
    logoWidth = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: rtl ? margin - 6 : W - margin + 6 - logoWidth, y: H - 132, width: logoWidth, height: h });
  }
  const titleRoom = W - margin * 2 - logoWidth - 12;
  drawStart(data.texts.title, margin, H - 72, textWidth(titleRoom, data.texts.title, 24, "bold"), "bold", white);
  drawStart(data.texts.tagline, margin, H - 104, textWidth(titleRoom, data.texts.tagline, 12, "regular"), "regular", rgb(0.55, 0.92, 0.7));

  // the licence
  let y = H - 200;
  drawStart(data.organizationName, margin, y, textWidth(W - margin * 2, data.organizationName, 20, "bold"), "bold", navy);
  y -= 22;
  drawStart(data.texts.licenseNumber, margin, y, 11, "regular", muted);
  y -= 30;

  const rows: [string, string][] = [
    [data.texts.plan, data.planValue],
    [data.texts.status, data.statusValue],
    [data.texts.users, data.usersValue],
    [data.texts.devices, data.devicesValue],
    [data.texts.validUntil, data.validUntilValue],
  ];
  const rowH = 34;
  page.drawRectangle({ x: margin, y: y - rows.length * rowH + 8, width: W - margin * 2, height: rows.length * rowH, color: soft, borderColor: line, borderWidth: 1 });
  rows.forEach(([label, value], index) => {
    drawStart(label, margin + 14, y - 14, 12.5, "bold", navy);
    drawEnd(value, margin + 16, y - 14, 13, "bold", ink);
    y -= rowH;
    if (index < rows.length - 1) page.drawLine({ start: { x: margin + 10, y: y + 8 }, end: { x: W - margin - 10, y: y + 8 }, thickness: 0.6, color: line });
  });

  // what changed: label on the start side; "before -> after" read in the page's direction,
  // ending at the end side
  y -= 26;
  drawStart(data.texts.whatChanged, margin, y, 15, "bold", blue);
  y -= 10;
  const arrow = (xFrom: number, xTo: number, yMid: number) => {
    page.drawLine({ start: { x: xFrom, y: yMid }, end: { x: xTo, y: yMid }, thickness: 1, color: muted });
    const dir = xTo > xFrom ? 1 : -1;
    page.drawLine({ start: { x: xTo, y: yMid }, end: { x: xTo - dir * 4, y: yMid + 3 }, thickness: 1, color: muted });
    page.drawLine({ start: { x: xTo, y: yMid }, end: { x: xTo - dir * 4, y: yMid - 3 }, thickness: 1, color: muted });
  };
  for (const change of data.changes) {
    y -= 26;
    page.drawCircle({ x: rtl ? W - margin - 6 : margin + 6, y: y + 4, size: 3.2, color: green });
    drawStart(change.label, margin + 16, y, 12, "bold", ink);
    const toWidth = widthOf(change.to, 12, "bold");
    drawEnd(change.to, margin + 16, y, 12, "bold", ink);
    if (change.from) {
      // on an Arabic page the line ends on the left: [after] <- [before]
      const afterEdge = rtl ? margin + 16 + toWidth + 6 : W - margin - 16 - toWidth - 6;
      const arrowLength = 16;
      const beforeEdge = rtl ? afterEdge + arrowLength + 6 : afterEdge - arrowLength - 6;
      arrow(rtl ? afterEdge + arrowLength : afterEdge - arrowLength, afterEdge, y + 4);
      if (rtl) drawLeft(change.from, beforeEdge, y, 12, "regular", muted);
      else drawRight(change.from, beforeEdge, y, 12, "regular", muted);
    }
  }
  if (data.changes.length === 0) {
    y -= 26;
    drawStart(data.texts.noChanges, margin + 16, y, 12, "regular", ink);
  }

  // Owner 2026-11-10: what the plan includes - a short summary line or two, then the features in
  // two columns, sized to fit above the footer
  if (data.includes && data.includes.features.length > 0) {
    y -= 34;
    drawStart(data.includes.title, margin, y, 15, "bold", blue);
    for (const line of data.includes.summary) {
      y -= 18;
      drawStart(line, margin, y, textWidth(W - margin * 2, line, 10, "regular"), "regular", muted);
    }
    y -= 8;
    const items = data.includes.features;
    const perColumn = Math.ceil(items.length / 2);
    const room = y - 92;
    const step = Math.max(12, Math.min(19, room / perColumn));
    const size = step >= 16 ? 10.5 : 9;
    const columnWidth = (W - margin * 2) / 2;
    items.forEach((label, index) => {
      const column = Math.floor(index / perColumn);
      const rowY = y - step * ((index % perColumn) + 1);
      const inset = margin + column * columnWidth;
      const dotX = rtl ? W - inset - 6 : inset + 6;
      page.drawCircle({ x: dotX, y: rowY + 3.5, size: 2.6, color: green });
      const text = label;
      const fit = textWidth(columnWidth - 22, text, size, "regular");
      if (rtl) drawRight(text, W - inset - 16, rowY, fit, "regular", ink);
      else drawLeft(text, inset + 16, rowY, fit, "regular", ink);
    });
  }

  // footer
  page.drawRectangle({ x: 0, y: 0, width: W, height: 70, color: soft });
  page.drawLine({ start: { x: 0, y: 70 }, end: { x: W, y: 70 }, thickness: 0.8, color: line });
  drawStart(data.texts.footer, margin, 42, textWidth(W - margin * 2, data.texts.footer, 10, "regular"), "regular", muted);
  drawStart(`${data.texts.issued}  ·  time.prosm.net`, margin, 22, 9, "regular", muted);

  return await doc.save();
}
