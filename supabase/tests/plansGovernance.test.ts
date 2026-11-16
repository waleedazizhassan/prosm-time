// Owner 2026-11-16, migration 20261117130000: the governance models follow the plan - Starter simple only, Business
// decentralized / centralized, Pro and up combined and per-kind; a downgrade is decided as simple at once.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { createOrg, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
const plan = (key: string) =>
  t.su("insert into entitlements (organization_id, plan, status) values ($1, $2, 'active') on conflict (organization_id) do update set plan = excluded.plan, status = 'active'", [org.id, key]);
const model = (m: string) => t.as(org.owner.authId, "select public.set_prosm_time_governance_model($1)", [m]);
const effective = async () => (await t.su<{ m: string }>("select public.prosm_time_approval_mode($1, 'leave') as m", [org.id]))[0].m;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "PlanGov");
});

describe("governance models by plan", () => {
  it("Starter: simple only", async () => {
    await plan("starter");
    expect((await model("centralized")).error).toMatch(/FEATURE NOT IN PLAN: governance_models/);
    expect((await model("direct")).error).toBeNull();
  });
  it("Business: decentralized and centralized, not combined nor per kind", async () => {
    await plan("business");
    expect((await model("centralized")).error).toBeNull();
    expect((await model("two_step")).error).toMatch(/governance_advanced/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_approval_mode('leave', 'decentralized')")).error).toMatch(/governance_advanced/);
  });
  it("Pro: combined; a downgrade to Starter is decided as simple, and the choice returns with the plan", async () => {
    await plan("pro");
    expect((await model("two_step")).error).toBeNull();
    expect(await effective()).toBe("two_step");
    await plan("starter");
    expect(await effective()).toBe("direct");
    await plan("pro");
    expect(await effective()).toBe("two_step");
  });
});
