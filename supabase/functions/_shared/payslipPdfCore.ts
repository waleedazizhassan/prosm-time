// Owner 2026-11-08/09: the payslip a manager emails to an employee, built on the server from the
// stored, approved snapshot of the published cycle version - never recalculated here - and laid
// out like the owner's reference payslip: PROSM Time | the organisation | issue date, time and
// pages; the title band; the employee box; earnings, deductions and installments side by side,
// each with its total; the net salary band with the amount in words; management approval.
// Only the payslip lines are shown (the lines in the net; never the extra allowances), so the
// visible lines add up to the net. Runs anywhere: the caller passes pdf-lib/fontkit and fonts.
// deno-lint-ignore-file no-explicit-any
import { textKit, type FontSet, type Weight } from "./pdfText.ts";
import { amountInWords, currencyLabel } from "./amountInWords.ts";
import { PROSM_FULL_LOGO_PNG, PROSM_MARK_PNG } from "./brandAssets.ts";

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
  /** HH:MM:SS, the time of issue */
  issuedTime?: string;
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

export interface PayslipLogo {
  bytes: Uint8Array;
  type: "png" | "jpg";
}

const LABELS: Record<string, [string, string]> = {
  title: ["مفردات مرتب", "Salary Payslip"],
  month: ["الشهر", "Month"],
  period: ["الفترة", "Period"],
  employee: ["اسم الموظف", "Employee name"],
  code: ["كود الموظف", "Employee code"],
  site: ["الإدارة / الموقع", "Department / Site"],
  earnings: ["الاستحقاقات", "Earnings"],
  deductions: ["الاستقطاعات", "Deductions"],
  installments: ["الأقساط", "Installments"],
  item: ["البيان", "Item"],
  value: ["القيمة", "Amount"],
  totalEarnings: ["إجمالي الاستحقاقات", "Total earnings"],
  totalDeductions: ["إجمالي الاستقطاعات", "Total deductions"],
  totalInstallments: ["إجمالي الأقساط", "Total installments"],
  net: ["صافي المرتب", "Net Salary"],
  issueDate: ["تاريخ الإصدار", "Issue date"],
  issueTime: ["الوقت", "Time"],
  pages: ["إجمالي الصفحات", "Total pages"],
  approval: ["اعتماد الإدارة", "Management approval"],
  serial: ["رقم الإصدار", "Serial"],
  version: ["إصدار الدورة", "Cycle version"],
  amended: ["نسخة معدّلة", "Amended version"],
  issuedVia: ["صادر من خلال", "Issued via"],
};

const money = (value: string | number) =>
  Number(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const wordsLanguage = (data: PayslipData) => (data.language === "en" ? "en" : "ar");

/** Every text that will be drawn - so the caller fetches exactly the fonts it needs. */
export function payslipTexts(data: PayslipData): string[] {
  return [
    ...Object.values(LABELS).flat(),
    "PROSM Time",
    data.organizationName, data.cycleTitle, data.employee.full_name, data.employee.employee_code ?? "", data.siteName ?? "",
    data.taxNotice ?? "", data.footerNote ?? "",
    amountInWords(data.employee.net_salary, data.employee.currency, wordsLanguage(data)),
    ...currencyLabel(data.employee.currency),
    ...data.employee.lines.flatMap((line) => [line.name_ar, line.name_en ?? ""]),
  ];
}

export async function buildPayslipPdf(
  libs: PayslipPdfLibs,
  fonts: { latin: FontPair; arabic: FontPair | null; cjk: FontPair | null },
  orgLogo: PayslipLogo | null,
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
  const L = (key: string) => (lang === "en" ? LABELS[key][1] : LABELS[key][0]);
  doc.setTitle(`${LABELS.title[1]} - ${data.employee.full_name} - ${data.cycleTitle}`);
  doc.setAuthor("PROSM Time Payroll");

  const navy = rgb(0.07, 0.17, 0.33);
  const ink = rgb(0.1, 0.13, 0.22);
  const muted = rgb(0.38, 0.43, 0.52);
  const rule = rgb(0.78, 0.82, 0.88);
  const band = rgb(0.86, 0.91, 0.96);
  const soft = rgb(0.94, 0.96, 0.98);
  const white = rgb(1, 1, 1);

  const page = doc.addPage([595.28, 841.89]);
  const H = page.getHeight();
  const k = textKit(page, fontFor, rtl);
  const W = k.W;
  const M = 34;
  // x of a box laid out from the start side: on an Arabic page the first box is the rightmost
  const boxX = (offsetFromStart: number, width: number) => (rtl ? W - M - offsetFromStart - width : M + offsetFromStart);
  const startIn = (text: string, x: number, width: number, inset: number, y: number, size: number, weight: Weight, color: any) =>
    rtl ? k.right(text, x + width - inset, y, size, weight, color) : k.left(text, x + inset, y, size, weight, color);
  const endIn = (text: string, x: number, width: number, inset: number, y: number, size: number, weight: Weight, color: any) =>
    rtl ? k.left(text, x + inset, y, size, weight, color) : k.right(text, x + width - inset, y, size, weight, color);
  const lineName = (line: PayslipLine) => (lang === "en" ? line.name_en || line.name_ar : line.name_ar);
  const box = (x: number, y: number, w: number, h: number, fill?: any, border = true) =>
    page.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: border ? rule : undefined, borderWidth: border ? 0.8 : 0 });

  // ---- header: the organisation leads in the middle; PROSM Time's full logo stays small on the
  // end side; the issue on the start side (owner 2026-11-09)
  let y = H - M;
  const brandW = 70;
  const brandX = rtl ? M : W - M - brandW;
  const fullLogo = await doc.embedPng(PROSM_FULL_LOGO_PNG);
  const logoH = 58;
  const logoW = (fullLogo.width / fullLogo.height) * logoH;
  page.drawImage(fullLogo, { x: brandX + (brandW - logoW) / 2, y: y - logoH, width: logoW, height: logoH });
  const dividerX = rtl ? brandX + brandW + 12 : brandX - 12;
  page.drawLine({ start: { x: dividerX, y: y - 4 }, end: { x: dividerX, y: y - 60 }, thickness: 0.8, color: rule });

  const metaW = 150;
  const metaX = boxX(0, metaW);
  const meta: [string, string][] = [
    ["issueDate", data.issuedAt],
    ["issueTime", data.issuedTime ?? ""],
    ["pages", "1"],
  ];
  meta.forEach(([key, value], i) => {
    const ry = y - 14 - i * 17;
    startIn(`${L(key)} :`, metaX, metaW, 0, ry, 9.5, "bold", ink);
    endIn(value, metaX, metaW, 0, ry, 9.5, "regular", ink);
  });

  const midLeft = rtl ? dividerX + 12 : M + metaW + 12;
  const midRight = rtl ? W - M - metaW - 12 : dividerX - 12;
  const midCenter = (midLeft + midRight) / 2;
  let nameY = y - 30;
  if (orgLogo) {
    try {
      const image = orgLogo.type === "png" ? await doc.embedPng(orgLogo.bytes) : await doc.embedJpg(orgLogo.bytes);
      const h = 44;
      const w = Math.min((image.width / image.height) * h, midRight - midLeft);
      page.drawImage(image, { x: midCenter - w / 2, y: y - h, width: w, height: h });
      nameY = y - 60;
    } catch {
      // an unreadable logo: the name alone
    }
  }
  k.center(data.organizationName, midCenter, nameY, k.fit(data.organizationName, midRight - midLeft, 14, "bold"), "bold", navy);
  y -= 80;

  // ---- title band
  box(M, y - 46, W - 2 * M, 46, band, false);
  if (lang === "bilingual") {
    k.center(LABELS.title[0], W / 2, y - 24, 21, "bold", ink);
    k.center(LABELS.title[1], W / 2, y - 39, 11, "regular", ink);
  } else {
    k.center(L("title"), W / 2, y - 30, 21, "bold", ink);
  }
  y -= 64;

  // ---- the month, and the period on the end side
  k.start(`${L("month")} :   ${data.cycleTitle}`, M + 10, y, 11, "bold", ink);
  k.end(`${data.periodStart}  -  ${data.periodEnd}`, M + 10, y, 9.5, "regular", muted);
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: navy });
  y -= 12;

  // ---- the employee box: code | name | department / site
  const empH = 48;
  box(M, y - empH, W - 2 * M, empH);
  const cells: [string, string, number][] = [
    ["code", data.employee.employee_code ?? "-", 0.22],
    ["employee", data.employee.full_name, 0.45],
    ["site", data.siteName ?? "-", 0.33],
  ];
  let offset = 0;
  for (const [i, [key, value, share]] of cells.entries()) {
    const cw = (W - 2 * M) * share;
    const cx = boxX(offset, cw);
    k.center(L(key), cx + cw / 2, y - 17, 10, "bold", ink);
    k.center(value, cx + cw / 2, y - 37, k.fit(value, cw - 12, 13, "bold"), "bold", ink);
    if (i > 0) {
      const lineX = rtl ? cx + cw : cx;
      page.drawLine({ start: { x: lineX, y: y - 8 }, end: { x: lineX, y: y - empH + 8 }, thickness: 0.8, color: rule });
    }
    offset += cw;
  }
  y -= empH + 16;

  // ---- earnings | deductions | installments, side by side, totals aligned
  const columns = [
    { title: "earnings", total: "totalEarnings", lines: data.employee.lines.filter((l) => l.category === "earning" || l.category === "allowance"), totalValue: data.employee.total_earnings },
    { title: "deductions", total: "totalDeductions", lines: data.employee.lines.filter((l) => l.category === "deduction"), totalValue: data.employee.total_deductions },
    { title: "installments", total: "totalInstallments", lines: data.employee.lines.filter((l) => l.category === "installment"), totalValue: data.employee.total_installments },
  ];
  const gap = 10;
  const colW = (W - 2 * M - 2 * gap) / 3;
  const headH = 26;
  const subH = 20;
  const totalH = 28;
  const rows = Math.max(5, ...columns.map((c) => c.lines.length));
  // shrink the rows on a payslip with many lines so everything stays on one page
  const rowH = Math.max(13, Math.min(19, (y - 230 - headH - subH - totalH) / rows));
  const colH = headH + subH + rows * rowH + totalH + 12;
  columns.forEach((column, i) => {
    const x = boxX(i * (colW + gap), colW);
    box(x, y - colH, colW, colH);
    box(x, y - headH, colW, headH, band, false);
    k.center(L(column.title), x + colW / 2, y - 18, 13, "bold", ink);
    const valueW = colW * 0.36;
    const splitX = rtl ? x + valueW : x + colW - valueW;
    box(x + 4, y - headH - subH, colW - 8, subH, soft, false);
    let ry = y - headH - 14;
    startIn(L("item"), x, colW - valueW, 0, ry, 10, "bold", ink);
    k.center(L("value"), rtl ? x + valueW / 2 : x + colW - valueW / 2, ry, 10, "bold", ink);
    ry = y - headH - subH;
    for (const line of column.lines) {
      const name = lineName(line);
      const nameX = rtl ? splitX : x;
      startIn(name, nameX, colW - valueW, 8, ry - rowH + 5, k.fit(name, colW - valueW - 14, 10), "regular", ink);
      k.center(money(line.amount), rtl ? x + valueW / 2 : x + colW - valueW / 2, ry - rowH + 5, k.fit(money(line.amount), valueW - 8, 10), "regular", ink);
      ry -= rowH;
      page.drawLine({ start: { x: x + 8, y: ry }, end: { x: x + colW - 8, y: ry }, thickness: 0.4, color: rule });
    }
    page.drawLine({ start: { x: splitX, y: y - headH - subH }, end: { x: splitX, y: y - headH - subH - rows * rowH }, thickness: 0.6, color: rule });
    const ty = y - colH + 6;
    box(x + 4, ty, colW - 8, totalH, soft, false);
    startIn(L(column.total), x, colW, 10, ty + 10, k.fit(L(column.total), colW * 0.6, 10.5, "bold"), "bold", ink);
    endIn(money(column.totalValue), x, colW, 10, ty + 10, 11.5, "bold", ink);
  });
  y -= colH + 16;

  // ---- net salary: label box | amount | currency | the amount in words
  const netH = 56;
  box(M, y - netH, W - 2 * M, netH, soft, false);
  const labelW = 120;
  const labelX = boxX(0, labelW);
  page.drawRectangle({ x: labelX, y: y - netH, width: labelW, height: netH, color: navy });
  if (lang === "bilingual") {
    k.center(LABELS.net[0], labelX + labelW / 2, y - 25, 15, "bold", white);
    k.center(LABELS.net[1], labelX + labelW / 2, y - 42, 9.5, "regular", white);
  } else {
    k.center(L("net"), labelX + labelW / 2, y - 33, 15, "bold", white);
  }
  const amountText = money(data.employee.net_salary);
  const amountW = 130;
  const amountX = boxX(labelW + 10, amountW);
  k.center(amountText, amountX + amountW / 2, y - 37, k.fit(amountText, amountW, 23, "bold"), "bold", ink);
  const [curLocal, curCode] = currencyLabel(data.employee.currency);
  const curW = 44;
  const curX = boxX(labelW + 10 + amountW + 4, curW);
  if (lang === "en") {
    k.center(curCode, curX + curW / 2, y - 33, 11, "bold", ink);
  } else {
    k.center(curLocal, curX + curW / 2, y - 26, 11, "bold", ink);
    k.center(curCode, curX + curW / 2, y - 40, 8.5, "regular", ink);
  }
  const dividerAt = rtl ? curX - 6 : curX + curW + 6;
  page.drawLine({ start: { x: dividerAt, y: y - 12 }, end: { x: dividerAt, y: y - netH + 12 }, thickness: 0.8, color: rule });
  const words = amountInWords(data.employee.net_salary, data.employee.currency, wordsLanguage(data));
  const wordsW = (W - 2 * M) - labelW - 10 - amountW - 4 - curW - 18;
  const wordsX = rtl ? M : dividerAt + 6;
  if (words) {
    const size = k.fit(words, wordsW - 10, 11);
    if (rtl) k.right(words, wordsX + wordsW - 4, y - 33, size, "regular", ink);
    else k.left(words, wordsX + 4, y - 33, size, "regular", ink);
  }
  y -= netH + 14;

  // ---- management approval, on the end side
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: navy });
  y -= 22;
  const signW = 170;
  const signX = rtl ? M + 10 : W - M - 10 - signW;
  k.center(L("approval"), signX + signW / 2, y, 11, "bold", ink);
  page.drawLine({ start: { x: signX, y: y - 24 }, end: { x: signX + signW, y: y - 24 }, thickness: 0.8, color: muted, dashArray: [1.5, 2] });

  // which issue this is
  const metaLine = `${L("serial")}: ${data.serial}   ·   ${L("version")}: v${data.cycleVersion}${data.cycleVersion > 1 ? `   ·   ${L("amended")}` : ""}`;
  k.start(metaLine, M + 10, y - 10, 8.5, "regular", muted);

  // footer: the organisation's notes and the product line
  let fy = 56;
  page.drawLine({ start: { x: M, y: fy + 14 }, end: { x: W - M, y: fy + 14 }, thickness: 0.6, color: rule });
  for (const note of [data.taxNotice, data.footerNote].filter((value): value is string => Boolean(value && value.trim()))) {
    k.center(note, W / 2, fy, k.fit(note, W - 2 * M, 8.5), "regular", muted);
    fy -= 13;
  }
  // issued through PROSM Time, beside its small mark
  const mark = await doc.embedPng(PROSM_MARK_PNG);
  const via = `${L("issuedVia")} PROSM Time`;
  const viaW = k.widthOf(via, 8.5, "regular");
  const markSize = 12;
  const totalW = viaW + 5 + markSize;
  const startX = W / 2 - totalW / 2;
  // the mark sits after the words in the reading direction
  const textX = rtl ? startX + markSize + 5 : startX;
  const markX = rtl ? startX : startX + viaW + 5;
  k.left(via, textX, 22, 8.5, "regular", muted);
  page.drawImage(mark, { x: markX, y: 19, width: markSize, height: markSize });

  return await doc.save();
}
