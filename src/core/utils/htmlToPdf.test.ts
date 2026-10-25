// Reports review (owner 2026-10-19): a PDF page ends between table rows,
// never through one.
import { describe, expect, it } from "vitest";

import { choosePageBreaks, groupPages } from "./htmlToPdf";

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

// v2.3.43 step 18 (item 16): a long report is captured a few pages at a
// time so no single canvas passes the browser's size limit.
describe("groupPages", () => {
  it("groups consecutive pages under the capture limit, covering the whole document", () => {
    // 4500 rows of 27px (3 months, many people), pages of ~1230px, captures of at most 5700px.
    const rows = Array.from({ length: 4500 }, (_, i) => (i + 1) * 27);
    const total = 4500 * 27;
    const breaks = choosePageBreaks(total, 1230, rows);
    const groups = groupPages(breaks, 5700);
    expect(groups.flatMap((group) => group.breaks)).toEqual(breaks);
    expect(groups[0].from).toBe(0);
    expect(groups[groups.length - 1].to).toBe(total);
    for (let i = 1; i < groups.length; i += 1) expect(groups[i].from).toBe(groups[i - 1].to);
    for (const group of groups) expect(group.to - group.from).toBeLessThanOrEqual(5700);
  });

  it("keeps a page taller than the limit as its own capture", () => {
    expect(groupPages([9000, 9500], 5000)).toEqual([
      { from: 0, to: 9000, breaks: [9000] },
      { from: 9000, to: 9500, breaks: [9500] },
    ]);
  });
});
