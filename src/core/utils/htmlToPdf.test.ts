// Reports review (owner 2026-10-19): a PDF page ends between table rows,
// never through one.
import { describe, expect, it } from "vitest";

import { choosePageBreaks } from "./htmlToPdf";

describe("choosePageBreaks", () => {
  it("ends each page at the last row that fits", () => {
    // Rows every 30 px; a page holds 100 px.
    const rows = Array.from({ length: 10 }, (_, i) => (i + 1) * 30);
    expect(choosePageBreaks(300, 100, rows)).toEqual([90, 180, 270, 300]);
  });

  it("cuts at the page height only when no row ends in the lower half of the page", () => {
    expect(choosePageBreaks(250, 100, [20, 230])).toEqual([100, 200, 250]);
  });

  it("leaves room for the repeated table header on the pages after the first", () => {
    // Header 10 px tall (40-50); the table runs to 300; rows every 30 px from 50.
    const rows = Array.from({ length: 9 }, (_, i) => 50 + (i + 1) * 30);
    const breaks = choosePageBreaks(300, 100, rows, { top: 40, from: 50, to: 300 });
    // Each page after the first holds 90 px of rows (100 minus the 10 px header).
    expect(breaks).toEqual([80, 170, 260, 300]);
  });

  it("is one page when everything fits", () => {
    expect(choosePageBreaks(80, 100, [30, 60])).toEqual([80]);
  });
});
