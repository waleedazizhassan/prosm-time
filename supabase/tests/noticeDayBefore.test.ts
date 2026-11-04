// 2026-11-01 (plan stage 3.6): the owner hears the day before a plan or trial ends,
// once, with no purchase wording. Migration 20261101200000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { createOrg } from "./support/fixtures";

const claim = "select kind from public.claim_prosm_time_trial_notices()";

describe("the day-before notice", () => {
  it("reaches a paid owner once", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Day Co");
    await t.su("update license_activation_state set expires_at = now() + interval '20 hours' where organization_id = $1", [org.id]);
    expect((await t.su<{ kind: string }>(claim)).map((row) => row.kind)).toEqual(["LICENSE_DAY"]);
    expect(await t.su(claim)).toEqual([]);
  });

  it("reaches a trial owner after the week's notice, and says nothing of buying", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Trial Day Co");
    await t.su("update license_activation_state set is_trial = true, expires_at = now() + interval '5 days' where organization_id = $1", [org.id]);
    expect((await t.su<{ kind: string }>(claim)).map((row) => row.kind)).toEqual(["ENDING"]);
    await t.su("update license_activation_state set expires_at = now() + interval '20 hours' where organization_id = $1", [org.id]);
    expect((await t.su<{ kind: string }>(claim)).map((row) => row.kind)).toEqual(["ENDING_DAY"]);
    const notes = await t.su<{ body: string }>("select body from notifications where organization_id = $1 and type <> 'license_changed'", [org.id]);
    expect(notes.length).toBe(2);
    expect(notes.map((note) => note.body).join(" ")).not.toMatch(/buy|اشتر/);
  });
});
