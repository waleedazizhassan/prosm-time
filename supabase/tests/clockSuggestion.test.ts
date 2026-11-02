// 2026-11-02 (plan stage 8.4): off by default, and the owner's to change.
// Migration 20261102140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("clock-in suggestion", () => {
  it("is off until the owner turns it on", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Suggest Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const value = async () => (await t.su<{ suggest_clock_in: boolean }>("select suggest_clock_in from organization_settings where organization_id = $1", [org.id]))[0].suggest_clock_in;

    expect(await value()).toBe(false);
    expect((await t.as(worker.authId, "select public.set_prosm_time_clock_suggestion(true)")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_clock_suggestion(true)")).error).toBeNull();
    expect(await value()).toBe(true);
  });
});
