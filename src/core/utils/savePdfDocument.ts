import type { jsPDF } from "jspdf";
import { Capacitor } from "@capacitor/core";
import saveGeneratedFile from "./saveGeneratedFile";
import ReportExportRepository from "../repositories/ReportExportRepository";

// PROSM Time - § live UX review, user-directed real bug: "PDFs don't
// export from mobile at all." See saveGeneratedFile.ts's own header
// for the full root cause (a browser-only download mechanism that
// silently does nothing in a Capacitor WebView). Web keeps jsPDF's own
// doc.save() exactly as before; native routes the same PDF bytes
// through the shared native-file-save/share path.
//
// § user-reported real gap (#4, 2026-09-15) - "once a report exports,
// it should be saved into Reports so I can pull it later even if I
// didn't save it at the time." Every real PDF export in this app
// already calls this one function - archiving here, once, covers
// every current and future export automatically rather than
// duplicating the same upload logic at each of the ~6 call sites.
// reportType is optional only so this utility still has a valid
// signature for a hypothetical future non-report PDF - every real
// caller today always passes one.
// Owner 2026-10-21 ("an Arabic page exports files with English names"): a file
// name in the reader's language - the report's title, then any name and the
// period, joined with dashes (characters a file system refuses are dropped).
export function exportFileName(...parts: (string | null | undefined)[]): string {
  const clean = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-"));
  return `${clean.join("-")}.pdf`;
}

export default async function savePdfDocument(doc: jsPDF, filename: string, reportType?: string, periodStart?: string, periodEnd?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    doc.save(filename);
  } else {
    const blob = doc.output("blob");
    await saveGeneratedFile(filename, blob);
  }

  if (reportType) {
    // Best-effort - errors are swallowed so a failed archive never
    // throws out of here and breaks the caller, but still awaited so a
    // caller that refreshes its own "recent exports" list right after
    // this resolves reliably sees the fresh row. The real download
    // above has already succeeded by the time this runs either way.
    await ReportExportRepository.persist(reportType, filename, doc.output("blob"), periodStart, periodEnd).catch(() => {});
  }
}

// Reports review (owner 2026-10-19): print straight from the app. On the
// web the PDF is loaded into a hidden frame and the browser's print dialog
// opens for it (no new window, so no pop-up blocker); if the browser can't
// print a frame it opens in a new tab, and failing that it is downloaded.
// In the phone and desktop apps the share sheet opens, which offers printing.
export async function printPdfDocument(doc: jsPDF, filename: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await saveGeneratedFile(filename, doc.output("blob"));
    return;
  }
  const url = URL.createObjectURL(doc.output("blob"));
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      if (!window.open(url, "_blank")) doc.save(filename);
    }
    // The dialog keeps its own copy; the frame goes once printing is surely over.
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60000);
  };
  document.body.appendChild(frame);
}
