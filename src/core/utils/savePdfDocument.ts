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
