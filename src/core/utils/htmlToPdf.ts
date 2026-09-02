import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// PROSM Time - shared by every "certified document" PDF builder
// (Timesheet report, Attendance Record). Extracted out of
// timesheetPdf.ts once a second caller needed the exact same
// capture-and-paginate routine - both jsPDF issues documented there
// (`.html()` always reconstructing text with its own Latin-1-only
// font, and a fixed-position source element riding into jsPDF's own
// clone) apply equally to any caller, so there is exactly one place
// that knows how to turn an offscreen container into a correct,
// Arabic-safe, multi-page PDF: html2canvas renders the real DOM (the
// browser's own text engine, not jsPDF's), and the resulting canvas
// is embedded as a plain image via addImage() - jsPDF never touches
// the text as text.
//
// `container` must be an unattached element (not yet in the DOM) with
// its own explicit width/padding/background already set by the
// caller - this function owns wrapping it in a zero-size hidden host,
// appending that host to the page, capturing, and removing it again
// (even on failure).
export async function renderHtmlToPdf(container: HTMLElement): Promise<jsPDF> {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;";
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  try {
    const canvas = await html2canvas(container, { scale: 1.4, useCORS: true, backgroundColor: "#ffffff" });

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 20;
    const marginY = 20;
    const contentWidthPt = 555;
    const pageContentHeightPt = 841.89 - marginY * 2;

    const pxPerPt = canvas.width / contentWidthPt;
    const pageContentHeightPx = pageContentHeightPt * pxPerPt;

    let renderedPx = 0;
    let firstPage = true;
    while (renderedPx < canvas.height) {
      const sliceHeightPx = Math.min(pageContentHeightPx, canvas.height - renderedPx);

      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      const sliceCtx = sliceCanvas.getContext("2d");
      if (!sliceCtx) break;
      sliceCtx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);

      if (!firstPage) doc.addPage();
      doc.addImage(sliceCanvas.toDataURL("image/jpeg", 0.92), "JPEG", marginX, marginY, contentWidthPt, sliceHeightPx / pxPerPt);

      renderedPx += sliceHeightPx;
      firstPage = false;
    }

    return doc;
  } finally {
    document.body.removeChild(wrapper);
  }
}

export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

// Arabic script relies on letters visually joining - letter-spacing
// (and its own uppercase transform, meaningless for Arabic anyway)
// breaks that joining and reads as crowded/displaced text.
export function sectionHeadingStyle(isRtl: boolean): string {
  return isRtl
    ? "font-weight:700;font-size:12px;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:20px 0 8px;"
    : "font-weight:700;font-size:12px;letter-spacing:0.03em;text-transform:uppercase;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:20px 0 8px;";
}
