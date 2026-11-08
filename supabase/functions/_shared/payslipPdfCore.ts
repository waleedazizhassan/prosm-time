// Owner 2026-11-08: the payslip a manager emails to an employee, built on the server from the
// stored, approved snapshot of the published cycle version - never recalculated here. It shows
// only the payslip lines (the lines in the net; never the extra allowances), so the visible
// lines add up to the net. Runs anywhere: the caller passes pdf-lib/fontkit and the fonts.
// Bilingual labels are drawn as two pieces (Arabic, then English) - never one mixed string,
// whose direction would scramble.
// deno-lint-ignore-file no-explicit-any
import { textKit, type FontSet, type Weight } from "./pdfText.ts";

type FontPair = { regular: Uint8Array; bold: Uint8Array; presubset?: boolean };

export interface PayslipLine {
  name_ar: string;
  name_en: string | null;
  category: "earning" | "allowance" | "deduction" | "installment";
  amount: string | number;
}

export interface PayslipData {
  language: "ar" | "en" | "bilingual";
  organizationName: string;
  cycleTitle: string;
  periodStart: string;
  periodEnd: string;
  cycleVersion: number;
  serial: number | string;
  issuedAt: string;
  employee: {
    full_name: string;
    employee_code: string | null;
    currency: string;
    total_earnings: string | number;
    total_deductions: string | number;
    total_installments: string | number;
    net_salary: string | number;
    lines: PayslipLine[];
  };
  siteName?: string | null;
  taxNotice?: string | null;
  footerNote?: string | null;
}

export interface PayslipPdfLibs {
  PDFDocument: any;
  rgb: (r: number, g: number, b: number) => any;
  fontkit: any;
}

const LABELS: Record<string, [string, string]> = {
  title: ["مفردات مرتب", "Salary Payslip"],
  period: ["الفترة", "Period"],
  employee: ["اسم الموظف", "Employee"],
  code: ["كود الموظف", "Employee code"],
  site: ["الموقع", "Site"],
  earnings: ["الاستحقاقات", "Earnings"],
  deductions: ["الاستقطاعات", "Deductions"],
  installments: ["الأقساط", "Installments"],
  item: ["البيان", "Item"],
  value: ["القيمة", "Amount"],
  totalEarnings: ["إجمالي الاستحقاقات", "Total earnings"],
  totalDeductions: ["إجمالي الاستقطاعات", "Total deductions"],
  totalInstallments: ["إجمالي الأقساط", "Total installments"],
  net: ["صافي المرتب", "Net salary"],
  serial: ["رقم الإصدار", "Serial"],
  version: ["إصدار الدورة", "Cycle version"],
  amended: ["نسخة معدّلة", "Amended version"],
  issued: ["تاريخ الإصدار", "Issued"],
  none: ["لا يوجد", "None"],
};

const money = (value: string | number) =>
  Number(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every text that will be drawn - so the caller fetches exactly the fonts it needs. */
export function payslipTexts(data: PayslipData): string[] {
  return [
    ...Object.values(LABELS).flat(),
    data.organizationName, data.cycleTitle, data.employee.full_name, data.employee.employee_code ?? "", data.siteName ?? "",
    data.taxNotice ?? "", data.footerNote ?? "",
    ...data.employee.lines.flatMap((line) => [line.name_ar, line.name_en ?? ""]),
  ];
}

export async function buildPayslipPdf(
  libs: PayslipPdfLibs,
  fonts: { latin: FontPair; arabic: FontPair | null; cjk: FontPair | null },
  logoPng: Uint8Array | null,
  data: PayslipData,
): Promise<Uint8Array> {
  const { PDFDocument, rgb, fontkit } = libs;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embed = async (pair: FontPair) => ({
    regular: await doc.embedFont(pair.regular, { subset: !pair.presubset }),
    bold: await doc.embedFont(pair.bold, { subset: !pair.presubset }),
  });
  const latin = await embed(fonts.latin);
  const fontFor: FontSet = { latin, arabic: fonts.arabic ? await embed(fonts.arabic) : latin, cjk: fonts.cjk ? await embed(fonts.cjk) : latin };

  const lang = data.language;
  const rtl = lang !== "en";
  doc.setTitle(`${LABELS.title[1]} - ${data.employee.full_name} - ${data.cycleTitle}`);
  doc.setAuthor("PROSM Time Payroll");

  const navy = rgb(0.06, 0.16, 0.32);
  const ink = rgb(0.11, 0.15, 0.25);
  const muted = rgb(0.4, 0.45, 0.55);
  const rule = rgb(0.86, 0.89, 0.93);
  const band = rgb(0.92, 0.95, 0.98);
  const white = rgb(1, 1, 1);
  const lightOnNavy = rgb(0.78, 0.84, 0.93);

  const page = doc.addPage([595.28, 841.89]);
  const H = page.getHeight();
  const k = textKit(page, fontFor, rtl);
  const W = k.W;
  const M = 40;
  const GAP = 6;

  // one label: Arabic, English, or both as two pieces (the second smaller, in the secondary colour)
  type Piece = { text: string; size: number; weight: Weight; color: any };
  const pieces = (key: string, size: number, weight: Weight, color: any, second: any): Piece[] => {
    const [ar, en] = LABELS[key];
    if (lang === "ar") return [{ text: ar, size, weight, color }];
    if (lang === "en") return [{ text: en, size, weight, color }];
    return [{ text: ar, size, weight, color }, { text: en, size: size * 0.82, weight: "regular", color: second }];
  };
  const widthOf = (list: Piece[]) => list.reduce((sum, p) => sum + k.widthOf(p.text, p.size, p.weight), 0) + GAP * (list.length - 1);
  // laid out from the start side: on an Arabic page the first piece is the rightmost
  const drawPiecesFrom = (list: Piece[], xLeft: number, y: number) => {
    let x = xLeft;
    for (const p of rtl ? [...list].reverse() : list) {
      k.left(p.text, x, y, p.size, p.weight, p.color);
      x += k.widthOf(p.text, p.size, p.weight) + GAP;
    }
  };
  const atStart = (list: Piece[], inset: number, y: number) => drawPiecesFrom(list, rtl ? W - inset - widthOf(list) : inset, y);
  const atEnd = (list: Piece[], inset: number, y: number) => drawPiecesFrom(list, rtl ? inset : W - inset - widthOf(list), y);
  const atCenter = (list: Piece[], xCenter: number, y: number) => drawPiecesFrom(list, xCenter - widthOf(list) / 2, y);
  const one = (key: string) => (lang === "en" ? LABELS[key][1] : LABELS[key][0]);
  const lineName = (line: PayslipLine) => (lang === "en" ? line.name_en || line.name_ar : line.name_ar);

  // header: the organisation on the start side, PROSM Time quietly on the end side
  let y = H - M;
  if (logoPng) {
    const logo = await doc.embedPng(logoPng);
    const h = 34;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: rtl ? M : W - M - w, y: y - h, width: w, height: h });
  } else {
    k.end("PROSM Time", M, y - 22, 12, "bold", navy);
  }
  k.start(data.organizationName, M, y - 22, k.fit(data.organizationName, W / 2, 16, "bold"), "bold", navy);
  y -= 50;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: rule });

  // title band and period
  y -= 40;
  page.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 40, color: band });
  atCenter(pieces("title", 18, "bold", navy, muted), W / 2, y + 6);
  y -= 28;
  atCenter([...pieces("period", 10, "bold", muted, muted), { text: data.cycleTitle, size: 10, weight: "regular", color: ink }], W / 2, y);
  y -= 14;
  k.center(`${data.periodStart}  -  ${data.periodEnd}`, W / 2, y, 9.5, "regular", muted);

  // employee box
  y -= 18;
  const boxH = 48;
  page.drawRectangle({ x: M, y: y - boxH, width: W - 2 * M, height: boxH, borderColor: rule, borderWidth: 0.8 });
  const cells: [string, string][] = [
    ["employee", data.employee.full_name],
    ["code", data.employee.employee_code ?? "-"],
    ["site", data.siteName ?? "-"],
  ];
  const cellW = (W - 2 * M) / cells.length;
  cells.forEach(([key, value], i) => {
    // the first cell on the start side
    const xCenter = rtl ? W - M - cellW * i - cellW / 2 : M + cellW * i + cellW / 2;
    atCenter(pieces(key, 8.5, "regular", muted, muted), xCenter, y - 16);
    k.center(value, xCenter, y - 35, k.fit(value, cellW - 10, 11.5, "bold"), "bold", ink);
  });
  y -= boxH + 18;

  // the three blocks: earnings, deductions, installments - each with its total
  const blocks = [
    { title: "earnings", total: "totalEarnings", lines: data.employee.lines.filter((l) => l.category === "earning" || l.category === "allowance"), totalValue: data.employee.total_earnings },
    { title: "deductions", total: "totalDeductions", lines: data.employee.lines.filter((l) => l.category === "deduction"), totalValue: data.employee.total_deductions },
    { title: "installments", total: "totalInstallments", lines: data.employee.lines.filter((l) => l.category === "installment"), totalValue: data.employee.total_installments },
  ];
  const rowH = 17;
  for (const block of blocks) {
    const rows = Math.max(block.lines.length, 1);
    const height = 22 + 16 + rows * rowH + 22;
    page.drawRectangle({ x: M, y: y - height, width: W - 2 * M, height, borderColor: rule, borderWidth: 0.8 });
    page.drawRectangle({ x: M, y: y - 22, width: W - 2 * M, height: 22, color: band });
    atCenter(pieces(block.title, 11.5, "bold", navy, muted), W / 2, y - 15);
    let ry = y - 22 - 13;
    atStart(pieces("item", 8.5, "bold", muted, muted), M + 10, ry);
    atEnd(pieces("value", 8.5, "bold", muted, muted), M + 10, ry);
    ry -= 4;
    if (block.lines.length === 0) {
      ry -= rowH - 4;
      k.start(one("none"), M + 10, ry, 9.5, "regular", muted);
    }
    for (const line of block.lines) {
      ry -= rowH - 4;
      const name = lineName(line);
      const second = lang === "bilingual" && line.name_en && line.name_en !== line.name_ar ? line.name_en : null;
      const room = (W - 2 * M) * 0.7;
      atStart(
        second
          ? [{ text: name, size: k.fit(name, room * 0.6, 10), weight: "regular", color: ink }, { text: second, size: k.fit(second, room * 0.4, 8.5), weight: "regular", color: muted }]
          : [{ text: name, size: k.fit(name, room, 10), weight: "regular", color: ink }],
        M + 10, ry);
      k.end(money(line.amount), M + 10, ry, 10, "regular", ink);
      ry -= 4;
      page.drawLine({ start: { x: M + 8, y: ry }, end: { x: W - M - 8, y: ry }, thickness: 0.4, color: rule });
    }
    const ty = y - height + 8;
    atStart(pieces(block.total, 10, "bold", navy, muted), M + 10, ty);
    k.end(money(block.totalValue), M + 10, ty, 10.5, "bold", navy);
    y -= height + 12;
  }

  // net salary, prominent, with its currency
  const netH = 46;
  page.drawRectangle({ x: M, y: y - netH, width: W - 2 * M, height: netH, color: navy });
  atStart(pieces("net", 13, "bold", white, lightOnNavy), M + 14, y - 29);
  k.end(`${money(data.employee.net_salary)} ${data.employee.currency}`, M + 14, y - 30, 17, "bold", white);
  y -= netH + 18;

  // which issue this is: its serial, the cycle version it comes from, the date
  const meta: [string, string][] = [
    ["serial", String(data.serial)],
    ["version", `v${data.cycleVersion}`],
    ["issued", data.issuedAt],
  ];
  const metaPieces: Piece[] = meta.flatMap(([key, value]) => [
    { text: `${one(key)}:`, size: 8.5, weight: "regular" as Weight, color: muted },
    { text: value, size: 8.5, weight: "bold" as Weight, color: ink },
  ]);
  atCenter(metaPieces, W / 2, y);
  if (data.cycleVersion > 1) {
    y -= 13;
    atCenter(pieces("amended", 8.5, "bold", navy, muted), W / 2, y);
  }

  // footer
  let fy = 54;
  page.drawLine({ start: { x: M, y: fy + 14 }, end: { x: W - M, y: fy + 14 }, thickness: 0.6, color: rule });
  for (const note of [data.taxNotice, data.footerNote].filter((value): value is string => Boolean(value && value.trim()))) {
    k.center(note, W / 2, fy, k.fit(note, W - 2 * M, 8.5), "regular", muted);
    fy -= 13;
  }
  k.center("PROSM Time  ·  Work, Tracked.", W / 2, 22, 8, "regular", muted);

  return await doc.save();
}
