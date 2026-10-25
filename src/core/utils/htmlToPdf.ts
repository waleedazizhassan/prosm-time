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
const PDF_SCALE = 1.4;
// Tallest single capture, in canvas pixels: safe on Android WebViews too.
const MAX_CAPTURE_PX = 12000;

export async function renderHtmlToPdf(container: HTMLElement): Promise<jsPDF> {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;";
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  try {
    // Owner 2026-10-19 (reports review): a page ends between rows, never
    // through one - the bottoms of table rows and of the document's blocks,
    // measured before the capture, are the allowed places to break.
    const box = container.getBoundingClientRect();
    const top = box.top;
    const cssWidth = box.width || 1;
    const cssHeight = box.height || 1;
    const bottoms = Array.from(container.querySelectorAll<HTMLElement>("tr, :scope > *, :scope > * > *")).map((el) => el.getBoundingClientRect().bottom - top);
    // The first table's header row is repeated at the top of each page the table continues onto.
    const thead = container.querySelector("thead");
    const headBox = thead?.getBoundingClientRect();
    const tableBox = thead?.closest("table")?.getBoundingClientRect();

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 20;
    const marginY = 20;
    const footerPt = 14;
    const contentWidthPt = 555;
    const pageHeightPt = 841.89;
    const pageContentHeightPt = pageHeightPt - marginY * 2 - footerPt;

    // Breaks are chosen in CSS pixels over the whole document.
    const cssPerPt = cssWidth / contentWidthPt;
    const repeat: RepeatedHeader | undefined =
      headBox && tableBox ? { top: Math.round(headBox.top - top), from: Math.round(headBox.bottom - top), to: Math.round(tableBox.bottom - top) } : undefined;
    const breaks = choosePageBreaks(Math.ceil(cssHeight), pageContentHeightPt * cssPerPt, bottoms, repeat);

    // v2.3.43 step 18 (item 16): a long period with many people used to be
    // one canvas tens of thousands of pixels tall - past what a browser (and
    // far past what an Android WebView) can draw, so the PDF came out blank
    // or failed. The document is now captured a few pages at a time, each
    // capture well under those limits.
    const capture = (y: number, height: number) => html2canvas(container, { scale: PDF_SCALE, useCORS: true, backgroundColor: "#ffffff", y, height });
    const header = repeat ? await capture(repeat.top, repeat.from - repeat.top) : null;
    const headerCssHeight = repeat ? repeat.from - repeat.top : 0;

    let pageStart = 0;
    let firstPage = true;
    for (const group of groupPages(breaks, MAX_CAPTURE_PX / PDF_SCALE)) {
      const chunk = await capture(group.from, group.to - group.from);
      const canvasPerCss = chunk.height / (group.to - group.from);
      for (const pageEnd of group.breaks) {
        const sliceCss = pageEnd - pageStart;
        const headCss = repeat && header && !firstPage && pageStart >= repeat.from && pageStart < repeat.to ? headerCssHeight : 0;

        const page = document.createElement("canvas");
        page.width = chunk.width;
        page.height = Math.max(1, Math.round((headCss + sliceCss) * canvasPerCss));
        const ctx = page.getContext("2d");
        if (!ctx) break;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, page.width, page.height);
        const headPx = Math.round(headCss * canvasPerCss);
        if (headPx > 0 && header) ctx.drawImage(header, 0, 0, header.width, header.height, 0, 0, page.width, headPx);
        ctx.drawImage(chunk, 0, Math.round((pageStart - group.from) * canvasPerCss), chunk.width, Math.round(sliceCss * canvasPerCss), 0, headPx, page.width, Math.round(sliceCss * canvasPerCss));

        if (!firstPage) doc.addPage();
        doc.addImage(page.toDataURL("image/jpeg", 0.85), "JPEG", marginX, marginY, contentWidthPt, (headCss + sliceCss) / cssPerPt);
        // free the page's memory at once (long reports on phones)
        page.width = 0;
        page.height = 0;

        pageStart = pageEnd;
        firstPage = false;
      }
      chunk.width = 0;
      chunk.height = 0;
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

/**
 * Consecutive pages captured together: as many as fit in `maxCss` CSS
 * pixels (always at least one page, however tall).
 */
export function groupPages(breaks: number[], maxCss: number): { from: number; to: number; breaks: number[] }[] {
  const groups: { from: number; to: number; breaks: number[] }[] = [];
  let from = 0;
  let current: number[] = [];
  for (const end of breaks) {
    if (current.length > 0 && end - from > maxCss) {
      const to = current[current.length - 1];
      groups.push({ from, to, breaks: current });
      from = to;
      current = [];
    }
    current.push(end);
  }
  if (current.length > 0) groups.push({ from, to: current[current.length - 1], breaks: current });
  return groups;
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
