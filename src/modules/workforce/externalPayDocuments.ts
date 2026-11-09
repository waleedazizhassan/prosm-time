import type { jsPDF } from "jspdf";
import type { TFunction } from "i18next";

import { escapeHtml, renderHtmlToPdf } from "../../core/utils/htmlToPdf";
import { toXlsx, type Cell } from "../../core/utils/spreadsheet";
import type { RunDetail, RunWorker } from "../../core/repositories/ExternalLaborRepository";
import { customerLogoHtml, issuedViaHtml, prosmLogoHtml } from "../../core/utils/reportBrand";

// 2026-11-08 B-07: the external labour pay report as files - one worker (a statement with every
// line) or many (one row each), PDF and Excel. The server computed every figure (from the frozen
// snapshot once approved); these builders only lay them out. Policy items and individual
// adjustments are separate lines; totals are per currency; a draft is marked as a draft.

const NAVY = "#10284f";
const RULE = "#dbe2ec";
const BAND = "#eef3f9";
const money = (value: number | string | null | undefined) =>
  value === null || value === undefined ? "-" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (rows: { amount: number; kind: string }[], kind: string) => rows.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.amount), 0);

type T = TFunction;

function header(detail: RunDetail, t: T, title: string): string {
  const meta = [
    `${t("externalPay:doc.period")}: ${detail.run.periodStart} - ${detail.run.periodEnd}`,
    detail.run.siteName ? `${t("externalPay:doc.site")}: ${detail.run.siteName}` : t("externalPay:doc.allSites"),
    `${t("externalPay:doc.version")}: v${detail.run.runVersion}`,
    detail.run.approvedAt ? `${t("externalPay:doc.approvedBy")}: ${detail.run.approvedBy ?? "-"} (${detail.run.approvedAt.slice(0, 10)})` : null,
    `${t("externalPay:doc.issued")}: ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid ${RULE};padding-bottom:12px;margin-bottom:14px;">
      <div style="text-align:start;min-width:200px;">
        <div style="font-size:20px;font-weight:700;color:${NAVY};">${escapeHtml(title)}</div>
        <div style="font-size:12px;color:#475569;">${escapeHtml(detail.run.title)}</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="display:inline-block;">${customerLogoHtml(detail.organization?.logoUrl, 54)}</div>
        <div style="font-size:16px;font-weight:700;color:${NAVY};">${escapeHtml(detail.organization?.name ?? "")}</div>
      </div>
      ${prosmLogoHtml(54)}
    </div>
    ${detail.run.isDraft ? `<div style="border:1px dashed #b45309;color:#b45309;text-align:center;padding:6px;margin-bottom:10px;font-weight:700;">${escapeHtml(t("externalPay:doc.draft"))}</div>` : ""}
    <div style="display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11px;color:#475569;margin-bottom:12px;">${meta.map((m) => `<span>${escapeHtml(String(m))}</span>`).join("")}</div>`;
}

const footer = () => `<div style="margin-top:16px;border-top:1px solid ${RULE};padding-top:4px;">${issuedViaHtml()}</div>`;

function container(isRtl: boolean, width: number): HTMLDivElement {
  const el = document.createElement("div");
  el.dir = isRtl ? "rtl" : "ltr";
  el.style.cssText = `width:${width}px;padding:28px;background:#ffffff;color:#0f172a;font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;`;
  return el;
}

function quantityText(w: RunWorker, t: T): string {
  return w.quantity === null ? "-" : `${w.quantity} ${t(`externalPay:unitQuantity.${w.unit}`)}`;
}

function statementHtml(detail: RunDetail, w: RunWorker, t: T, isRtl: boolean): string {
  const end = isRtl ? "left" : "right";
  const row = (label: string, value: string, bold = false, note = "") =>
    `<tr style="${bold ? `font-weight:700;color:${NAVY};` : ""}"><td style="padding:6px 10px;border-top:1px solid ${RULE};">${escapeHtml(label)}${note ? `<div style="font-size:10px;color:#64748b;font-weight:400;">${escapeHtml(note)}</div>` : ""}</td><td style="padding:6px 10px;border-top:1px solid ${RULE};text-align:${end};white-space:nowrap;">${escapeHtml(value)}</td></tr>`;
  const lines = [
    row(t("externalPay:doc.rate"), `${money(w.rate)} ${w.currency} / ${t(`externalPay:unit.${w.unit}`)}`),
    row(t("externalPay:doc.quantity"), quantityText(w, t), false, w.quantitySource === "attendance" ? t("externalPay:doc.fromKiosk") : w.quantityNote ?? t("externalPay:doc.enteredManually")),
    row(t("externalPay:doc.gross"), money(w.gross), true),
    ...w.policyLines.map((line) => row(`${line.kind === "addition" ? "+" : "-"} ${line.name}`, money(line.amount), false, line.calc === "percent" ? `${line.value}% ${t("externalPay:doc.ofGross")}` : t("externalPay:doc.policyItem"))),
    ...w.adjustments.map((adj) => row(`${adj.kind === "addition" ? "+" : "-"} ${t(`externalPay:adjustment.${adj.kind}`)}`, money(adj.amount), false,
      `${t("externalPay:doc.manualAdjustment")} · ${adj.reason}${adj.quantity ? ` · ${adj.quantity} ${t("externalPay:unitQuantity.DAILY")}` : ""}`)),
  ].join("");
  return `
    ${header(detail, t, t("externalPay:doc.statementTitle"))}
    <table style="width:100%;border-collapse:collapse;border:1px solid ${RULE};margin-bottom:12px;font-size:12px;"><tr>
      <td style="padding:8px;text-align:center;"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("externalPay:doc.worker"))}</div><b>${escapeHtml(w.name)}</b></td>
      <td style="padding:8px;text-align:center;border-inline-start:1px solid ${RULE};"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("externalPay:doc.number"))}</div><b>${escapeHtml(w.workerNumber ?? "-")}</b></td>
      <td style="padding:8px;text-align:center;border-inline-start:1px solid ${RULE};"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("externalPay:doc.contractor"))}</div><b>${escapeHtml(w.contractorName ?? "-")}</b></td>
      <td style="padding:8px;text-align:center;border-inline-start:1px solid ${RULE};"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("externalPay:doc.site"))}</div><b>${escapeHtml(w.siteName ?? "-")}</b></td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;border:1px solid ${RULE};font-size:12px;"><tbody>${lines}</tbody></table>
    <div style="display:flex;justify-content:space-between;align-items:center;background:${NAVY};color:#fff;padding:12px 16px;font-size:16px;font-weight:700;margin-top:10px;">
      <span>${escapeHtml(t("externalPay:doc.net"))}</span><span>${money(w.net)} ${escapeHtml(w.currency)}</span>
    </div>
    ${footer()}`;
}

interface Table {
  head: string[];
  rows: Cell[][];
  totals: Cell[][];
}

function bulkTable(detail: RunDetail, workers: RunWorker[], t: T): Table {
  const head = ["#", t("externalPay:doc.number"), t("externalPay:doc.worker"), t("externalPay:doc.contractor"), t("externalPay:doc.site"),
    t("externalPay:doc.unit"), t("externalPay:doc.rate"), t("externalPay:doc.quantity"), t("externalPay:doc.gross"),
    t("externalPay:doc.policyAdditions"), t("externalPay:doc.policyDeductions"), t("externalPay:doc.manualAdditions"), t("externalPay:doc.manualDeductions"),
    t("externalPay:doc.net"), t("externalPay:doc.currency")];
  const rows = workers.map((w, i) => [String(i + 1), w.workerNumber ?? "", w.name, w.contractorName ?? "", w.siteName ?? "", t(`externalPay:unit.${w.unit}`),
    Number(w.rate), w.quantity === null ? "" : Number(w.quantity), w.gross === null ? "" : Number(w.gross),
    sum(w.policyLines, "addition"), sum(w.policyLines, "deduction"), sum(w.adjustments, "addition"), sum(w.adjustments, "deduction"),
    w.net === null ? "" : Number(w.net), w.currency]);
  const currencies = [...new Set(workers.map((w) => w.currency))].sort();
  const totals = currencies.map((currency) => {
    const mine = workers.filter((w) => w.currency === currency);
    const add = (pick: (w: RunWorker) => number) => mine.reduce((total, w) => total + pick(w), 0);
    return ["", "", `${t("externalPay:doc.total")} (${currency})`, "", "", "", "", "", add((w) => Number(w.gross ?? 0)),
      add((w) => sum(w.policyLines, "addition")), add((w) => sum(w.policyLines, "deduction")), add((w) => sum(w.adjustments, "addition")),
      add((w) => sum(w.adjustments, "deduction")), add((w) => Number(w.net ?? 0)), currency];
  });
  void detail;
  return { head, rows, totals };
}

function tableHtml(table: Table, isRtl: boolean): string {
  const cell = (value: Cell, bold = false) =>
    `<td style="padding:5px 6px;border:1px solid ${RULE};${typeof value === "number" ? `text-align:${isRtl ? "left" : "right"};white-space:nowrap;` : ""}${bold ? "font-weight:700;" : ""}">${escapeHtml(typeof value === "number" ? money(value) : value)}</td>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:10px;">
    <thead><tr style="background:${NAVY};color:#fff;">${table.head.map((h) => `<th style="padding:6px;border:1px solid ${NAVY};">${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${table.rows.map((r) => `<tr>${r.map((c) => cell(c)).join("")}</tr>`).join("")}
    ${table.totals.map((r) => `<tr style="background:${BAND};">${r.map((c) => cell(c, true)).join("")}</tr>`).join("")}</tbody></table>`;
}

/** One worker: a full statement; several: one statement page each when `statements`, else one table. */
export async function buildExternalPayPdf(detail: RunDetail, workers: RunWorker[], t: T, isRtl: boolean, statements: boolean): Promise<jsPDF | null> {
  if (statements || workers.length === 1) {
    let doc: jsPDF | null = null;
    for (const [index, w] of workers.entries()) {
      const el = container(isRtl, 640);
      el.innerHTML = statementHtml(detail, w, t, isRtl);
      doc = await renderHtmlToPdf(el, { doc: doc ?? undefined, numberPages: index === workers.length - 1 });
    }
    return doc;
  }
  const el = container(isRtl, 1120);
  el.innerHTML = `${header(detail, t, t("externalPay:doc.reportTitle"))}${tableHtml(bulkTable(detail, workers, t), isRtl)}${footer()}`;
  return renderHtmlToPdf(el, { landscape: true });
}

export function buildExternalPayXlsx(detail: RunDetail, workers: RunWorker[], t: T, isRtl: boolean): Uint8Array {
  const table = bulkTable(detail, workers, t);
  const banner: Cell[][] = detail.run.isDraft ? [[t("externalPay:doc.draft")]] : [];
  // the individual adjustments under the table, one line each, with their reason
  const adjustments: Cell[][] = workers.flatMap((w) => w.adjustments.map((adj) => [w.workerNumber ?? "", w.name, t(`externalPay:adjustment.${adj.kind}`), Number(adj.amount), w.currency, adj.reason] as Cell[]));
  const tail: Cell[][] = adjustments.length ? [[], [t("externalPay:doc.manualAdjustments")], [t("externalPay:doc.number"), t("externalPay:doc.worker"), t("externalPay:doc.kind"), t("externalPay:doc.amount"), t("externalPay:doc.currency"), t("externalPay:doc.reason")], ...adjustments] : [];
  return toXlsx([...banner, table.head, ...table.rows, ...table.totals, ...tail], isRtl, { freezeHeader: !detail.run.isDraft, autoFilter: false, sheetName: t("externalPay:doc.reportTitle") });
}
