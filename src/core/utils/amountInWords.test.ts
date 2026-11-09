// The amount in words on payslips (owner 2026-11-09 reference payslip).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { amountInWords } from "./amountInWords";

describe("amountInWords", () => {
  it("writes the reference payslip's Arabic exactly", () => {
    expect(amountInWords(3078.6, "EGP", "ar")).toBe("فقط ثلاثة آلاف وثمانية وسبعون جنيهًا وستون قرشًا لا غير");
    expect(amountInWords(785, "EGP", "ar")).toBe("فقط سبعمائة وخمسة وثمانون جنيهًا لا غير");
  });

  it("follows the Arabic counted-noun rules", () => {
    expect(amountInWords(1, "EGP", "ar")).toBe("فقط جنيه واحد لا غير");
    expect(amountInWords(2, "EGP", "ar")).toBe("فقط جنيهان لا غير");
    expect(amountInWords(7, "EGP", "ar")).toBe("فقط سبعة جنيهات لا غير");
    expect(amountInWords(100, "EGP", "ar")).toBe("فقط مائة جنيه لا غير");
    expect(amountInWords(2000, "EGP", "ar")).toBe("فقط ألفان جنيه لا غير");
    expect(amountInWords(11000, "EGP", "ar")).toBe("فقط أحد عشر ألف جنيه لا غير");
    expect(amountInWords(11500, "EGP", "ar")).toBe("فقط أحد عشر ألفًا وخمسمائة جنيه لا غير");
    expect(amountInWords(1250000, "USD", "ar")).toBe("فقط مليون ومائتان وخمسون ألف دولار لا غير");
    expect(amountInWords(3.05, "SAR", "ar")).toBe("فقط ثلاثة ريالات وخمس هللات لا غير");
  });

  it("writes English for other languages", () => {
    expect(amountInWords(3078.6, "EGP", "en")).toBe("Three thousand seventy-eight Egyptian pounds and sixty piastres only");
    expect(amountInWords(1, "USD", "fr")).toBe("One US dollar only");
  });

  it("is the same file the server PDF uses", () => {
    const client = readFileSync("src/core/utils/amountInWords.ts", "utf8").replace(/\r\n/g, "\n");
    const server = readFileSync("supabase/functions/_shared/amountInWords.ts", "utf8").replace(/\r\n/g, "\n");
    expect(server).toBe(client);
  });
});
