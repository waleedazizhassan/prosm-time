import type { jsPDF } from "jspdf";
import { Capacitor } from "@capacitor/core";
import saveGeneratedFile from "./saveGeneratedFile";

// PROSM Time - § live UX review, user-directed real bug: "PDFs don't
// export from mobile at all." See saveGeneratedFile.ts's own header
// for the full root cause (a browser-only download mechanism that
// silently does nothing in a Capacitor WebView). Web keeps jsPDF's own
// doc.save() exactly as before; native routes the same PDF bytes
// through the shared native-file-save/share path.
export default async function savePdfDocument(doc: jsPDF, filename: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    doc.save(filename);
    return;
  }

  const blob = doc.output("blob");
  await saveGeneratedFile(filename, blob);
}
