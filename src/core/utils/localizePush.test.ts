// Owner 2026-10-20: push notifications in the phone's language, with the
// in-app bell's own texts. Also checks the server copy of those texts is
// up to date with the app's translations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { localizePush } from "../../../supabase/functions/_shared/localizePush";
// @ts-expect-error - plain .mjs build script
import { buildPushTexts, renderPushTextsModule } from "../../../scripts/gen-push-texts.mjs";

const fallback = { title: "SOS/Emergency alert", body: "Lido triggered an SOS" };

describe("push notification texts", () => {
  it("writes an SOS in Arabic and English from its data", () => {
    const ar = localizePush("sos_alert", { employeeName: "Lido" }, "ar", fallback);
    expect(ar.title).not.toBe(fallback.title);
    expect(ar.body).toContain("Lido");
    expect(ar.title).toMatch(/[؀-ۿ]/);
    const en = localizePush("sos_alert", { employeeName: "Lido" }, "en", fallback);
    expect(en.body).toContain("Lido");
  });

  it("names the leave type in the phone's language", () => {
    const ar = localizePush("exception_pending_review", { employeeName: "Omar", kind: "leave", days: 2, leaveType: "annual", startDate: "2026-10-21", endDate: "2026-10-22" }, "ar", fallback);
    expect(ar.body).toContain("Omar");
    expect(ar.body).toContain("2026-10-21");
  });

  it("keeps the stored text for a type it doesn't know", () => {
    expect(localizePush("something_new", {}, "ar", fallback)).toEqual(fallback);
  });

  it("matches the app's current translations (run node scripts/gen-push-texts.mjs)", () => {
    const current = readFileSync("supabase/functions/_shared/pushTexts.ts", "utf8").replace(/\r\n/g, "\n");
    expect(current).toBe(renderPushTextsModule(buildPushTexts(".")));
  });
});
