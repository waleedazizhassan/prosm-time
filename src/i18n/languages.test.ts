// Audit 4.2 - the app opens in the device language when it is supported.
import { describe, expect, it } from "vitest";

import { initialLanguage } from "./languages";

describe("initialLanguage", () => {
  it("uses the device language on first launch", () => {
    expect(initialLanguage(null, ["ar-EG", "en-US"])).toBe("ar");
    expect(initialLanguage(null, ["fr"])).toBe("fr");
  });

  it("skips unsupported device languages, then falls back to English", () => {
    expect(initialLanguage(null, ["es-ES", "de-DE"])).toBe("de");
    expect(initialLanguage(null, ["ja-JP"])).toBe("en");
    expect(initialLanguage(null, [])).toBe("en");
  });

  it("keeps the person's own choice", () => {
    expect(initialLanguage("it", ["ar-EG"])).toBe("it");
    expect(initialLanguage("xx", ["ar-EG"])).toBe("ar");
  });
});
