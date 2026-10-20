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
    // Owner 2026-10-19 (reports review): a page ends between rows, never
    // through one - the bottoms of table rows and of the document's blocks,
    // measured before the capture, are the allowed places to break.
    const top = container.getBoundingClientRect().top;
    const cssHeight = container.getBoundingClientRect().height || 1;
    const bottoms = Array.from(container.querySelectorAll<HTMLElement>("tr, :scope > *, :scope > * > *")).map((el) => el.getBoundingClientRect().bottom - top);
    // The first table's header row is repeated at the top of each page the table continues onto.
    const thead = container.querySelector("thead");
    const headBox = thead?.getBoundingClientRect();
    const tableBox = thead?.closest("table")?.getBoundingClientRect();

    const canvas = await html2canvas(container, { scale: 1.4, useCORS: true, backgroundColor: "#ffffff" });

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 20;
    const marginY = 20;
    const footerPt = 14;
    const contentWidthPt = 555;
    const pageHeightPt = 841.89;
    const pageContentHeightPt = pageHeightPt - marginY * 2 - footerPt;

    const pxPerPt = canvas.width / contentWidthPt;
    const pageContentHeightPx = pageContentHeightPt * pxPerPt;
    const cssToCanvas = canvas.height / cssHeight;
    const repeat: RepeatedHeader | undefined =
      headBox && tableBox
        ? { top: Math.round((headBox.top - top) * cssToCanvas), from: Math.round((headBox.bottom - top) * cssToCanvas), to: Math.round((tableBox.bottom - top) * cssToCanvas) }
        : undefined;
    const breaks = choosePageBreaks(canvas.height, pageContentHeightPx, bottoms.map((bottom) => bottom * cssToCanvas), repeat);

    let renderedPx = 0;
    let firstPage = true;
    for (const breakPx of breaks) {
      const sliceHeightPx = breakPx - renderedPx;
      const headPx = repeat && !firstPage && renderedPx >= repeat.from && renderedPx < repeat.to ? repeat.from - repeat.top : 0;

      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = headPx + sliceHeightPx;
      const sliceCtx = sliceCanvas.getContext("2d");
      if (!sliceCtx) break;
      if (headPx > 0 && repeat) sliceCtx.drawImage(canvas, 0, repeat.top, canvas.width, headPx, 0, 0, canvas.width, headPx);
      sliceCtx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, headPx, canvas.width, sliceHeightPx);

      if (!firstPage) doc.addPage();
      doc.addImage(sliceCanvas.toDataURL("image/jpeg", 0.92), "JPEG", marginX, marginY, contentWidthPt, (headPx + sliceHeightPx) / pxPerPt);

      renderedPx += sliceHeightPx;
      firstPage = false;
    }

    // Page numbers ("2 / 5") at the foot of every page.
    const pages = doc.getNumberOfPages();
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page);
      doc.text(`${page} / ${pages}`, doc.internal.pageSize.getWidth() / 2, pageHeightPt - marginY + 4, { align: "center" });
    }

    return doc;
  } finally {
    document.body.removeChild(wrapper);
  }
}

/**
 * Where each page ends, in canvas pixels: as far down as fits, but at the
 * last allowed break (a row's or block's bottom) when one falls in the lower
 * part of the page; a hard cut only when nothing suitable is there.
 */
// A table header (canvas pixels): drawn from `top` to `from`; repeated on a page that starts between `from` and `to`.
export interface RepeatedHeader {
  top: number;
  from: number;
  to: number;
}

export function choosePageBreaks(totalPx: number, pagePx: number, candidatesPx: number[], repeat?: RepeatedHeader): number[] {
  const candidates = [...new Set(candidatesPx.map((value) => Math.round(value)))].filter((value) => value > 0 && value < totalPx).sort((a, b) => a - b);
  const breaks: number[] = [];
  let start = 0;
  while (start < totalPx) {
    const room = repeat && start > 0 && start >= repeat.from && start < repeat.to ? pagePx - (repeat.from - repeat.top) : pagePx;
    const limit = start + room;
    if (limit >= totalPx) {
      breaks.push(totalPx);
      break;
    }
    const fitting = candidates.filter((value) => value > start + room * 0.5 && value <= limit);
    const end = fitting.length > 0 ? fitting[fitting.length - 1] : limit;
    breaks.push(end);
    start = end;
  }
  return breaks;
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
