import { describe, expect, it } from "vitest";

import { toCsv, toXlsx } from "./spreadsheet";

describe("spreadsheet export", () => {
  it("quotes CSV cells and stops a typed name running as a formula", () => {
    expect(toCsv([["a,b", 1.5], ['say "hi"', "=SUM(A1)"]])).toBe('﻿"a,b",1.5\r\n"say ""hi""",\'=SUM(A1)\r\n');
  });

  it("builds a zip holding numbers as numbers, text escaped", () => {
    const bytes = toXlsx([["وليد <&>", 7]], true);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 3, 4]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("<v>7</v>");
    expect(text).toContain("وليد &lt;&amp;&gt;");
    expect(text).toContain('rightToLeft="1"');
  });
});
