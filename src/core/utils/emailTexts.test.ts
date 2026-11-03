// Owner 2026-11-03: every email, and the licence PDF it carries, in the reader's language.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { emailLanguage, emailT, isRtl } from "../../../supabase/functions/_shared/emailI18n";
import { buildEmailTexts, renderEmailTextsModule } from "../../../scripts/gen-push-texts.mjs";
import { LANGUAGE_CODES } from "../../i18n/languages";

describe("email texts", () => {
  it("matches the app's current translations (run node scripts/gen-push-texts.mjs)", () => {
    const current = readFileSync("supabase/functions/_shared/emailTexts.ts", "utf8").replace(/\r\n/g, "\n");
    expect(current).toBe(renderEmailTextsModule(buildEmailTexts(".")));
  });

  it("has every language the app offers", () => {
    for (const code of LANGUAGE_CODES) expect(emailLanguage(code)).toBe(code);
    expect(emailLanguage("ja")).toBe("en");
    expect(emailLanguage("pt-BR")).toBe("pt");
  });

  it("uses each language's own plural forms", () => {
    expect(emailT("ru", "invite.expires", { count: 1 })).not.toBe(emailT("ru", "invite.expires", { count: 5 }));
    expect(emailT("ar", "reset.expires", { count: 15 })).toContain("15");
    expect(emailT("zh", "invite.expires", { count: 7 })).toContain("7");
  });

  it("writes the licence email in the reader's language, right to left only in Arabic", () => {
    expect(emailT("es", "licence.subject", { org: "Ratomag" })).toContain("Ratomag");
    expect(emailT("zh", "licence.pdf.title")).toContain("PROSM Time");
    expect(isRtl("ar")).toBe(true);
    expect(LANGUAGE_CODES.filter(isRtl)).toEqual(["ar"]);
  });
});
