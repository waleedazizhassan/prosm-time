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

  // Owner 2026-10-20: reviewed location/offline time, the trial notices and the reviewer's note.
  it("names a reviewed location or offline time and adds the reviewer's note", () => {
    const location = localizePush("correction_reviewed", { kind: "mock_location", actionType: "approved" }, "en", fallback);
    expect(location.title).toBe("Your location was reviewed");
    expect(location.body).toBe("Decision: Approved.");
    const offline = localizePush("correction_reviewed", { kind: "offline_time", actionType: "rejected", notes: "No proof" }, "en", fallback);
    expect(offline.title).toBe("Your offline time was reviewed");
    expect(offline.body).toBe('Decision: Rejected. Note: "No proof"');
    expect(localizePush("timesheet_rejected", { notes: "Fix Monday" }, "ar", fallback).body).toContain("Fix Monday");
    expect(localizePush("timesheet_approved", {}, "en", fallback).body).not.toContain("Note");
  });

  it("writes the trial notices in the phone's language", () => {
    expect(localizePush("trial_ending", { licenseNumber: "X" }, "ar", fallback).title).toMatch(/[؀-ۿ]/);
    expect(localizePush("trial_ended", {}, "en", fallback).title).toBe("Your PROSM Time trial has ended");
  });

  it("keeps the stored text for a type it doesn't know", () => {
    expect(localizePush("something_new", {}, "ar", fallback)).toEqual(fallback);
  });

  it("matches the app's current translations (run node scripts/gen-push-texts.mjs)", () => {
    const current = readFileSync("supabase/functions/_shared/pushTexts.ts", "utf8").replace(/\r\n/g, "\n");
    expect(current).toBe(renderPushTextsModule(buildPushTexts(".")));
  });
});
