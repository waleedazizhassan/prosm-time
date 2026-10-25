// v2.3.43 step 18 (item 16): a large file is written to the phone in whole
// base64 pieces, and closing the share sheet is not reported as an error.
import { describe, expect, it } from "vitest";

import { chunkRanges, isShareCancel } from "./saveGeneratedFile";

describe("saveGeneratedFile helpers", () => {
  it("splits a file into pieces that cover it exactly", () => {
    expect(chunkRanges(10, 3)).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 10],
    ]);
    expect(chunkRanges(0, 3)).toEqual([[0, 0]]);
    const ranges = chunkRanges(40 * 1024 * 1024 + 7, 3 * 1024 * 1024);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(40 * 1024 * 1024 + 7);
    for (const [start] of ranges) expect(start % 3).toBe(0);
  });

  it("knows a cancelled share sheet", () => {
    expect(isShareCancel(new Error("Share canceled"))).toBe(true);
    expect(isShareCancel(new Error("No space left"))).toBe(false);
  });
});
