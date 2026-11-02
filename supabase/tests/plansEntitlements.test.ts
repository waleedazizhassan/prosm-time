// 2026-11-01 (plan stage 3): plans enforced on the server, one-use codes, and
// no change for customers who exist today. Migration 20261101120000.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestOrg } from "./support/fixtures";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const setPlan = (t: TestDatabase, org: TestOrg, plan: string, seats: number | null = null) =>
  t.su("update entitlements set plan = $2, seats = $3, status = 'active' where organization_id = $1", [org.id, plan, seats]);
const code = (t: TestDatabase, value: string, plan = "business") =>
  t.su("insert into activation_codes (code_hash, plan, duration_days) values ($1, $2, 90)", [hash(value), plan]);
const redeem = (t: TestDatabase, org: TestOrg, value: string) =>
  t.as<{ r: { success: boolean; error?: string } }>(org.owner.authId, "select public.redeem_prosm_time_activation_code($1) as r", [value]);

describe("plans and entitlements", () => {
  it("a customer with no plan set has no new limit", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Legacy Co");
    const [row] = await t.su<{ plan: string }>("select plan from entitlements where organization_id = $1", [org.id]);
    expect(row.plan).toBe("legacy");
    for (const name of ["A", "B", "C", "D"]) await createSite(t, org, name);
  });

  it("refuses a site or an employee over the plan on the server", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Starter Co");
    await setPlan(t, org, "starter", 2);
    await createSite(t, org, "Second");
    await createSite(t, org, "Third");
    await expect(createSite(t, org, "Fourth")).rejects.toThrow(/PLAN SITE LIMIT REACHED/);
    await addMember(t, org, "employee", "One");
    await expect(addMember(t, org, "employee", "Two")).rejects.toThrow();
  });

  it("gives 7 days of grace after a paid plan, none after a trial, and deletes nothing", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Grace Co");
    const locked = async () => (await t.su<{ l: boolean }>("select public.prosm_time_org_locked($1) as l", [org.id]))[0].l;
    await t.su("update license_activation_state set expires_at = now() - interval '3 days' where organization_id = $1", [org.id]);
    expect(await locked()).toBe(false);
    await t.su("update license_activation_state set expires_at = now() - interval '8 days' where organization_id = $1", [org.id]);
    expect(await locked()).toBe(true);
    await t.su("update license_activation_state set expires_at = now() - interval '1 day', is_trial = true where organization_id = $1", [org.id]);
    expect(await locked()).toBe(true);
    expect(await t.su("select id from sites where organization_id = $1", [org.id])).not.toHaveLength(0);
  });

  it("a code works once, for the owner, and failures are recorded", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Code Co");
    const other = await createOrg(t, "Other Code Co");
    const member = await addMember(t, org, "employee", "Worker");
    await code(t, "ABCD-1234");

    expect((await t.as(member.authId, "select public.redeem_prosm_time_activation_code('ABCD-1234')")).error).toMatch(/ONLY THE OWNER/);
    expect((await redeem(t, org, "WRONG")).rows![0].r).toMatchObject({ success: false });
    expect((await redeem(t, org, " abcd-1234 ")).rows![0].r).toMatchObject({ success: true });
    expect((await redeem(t, other, "ABCD-1234")).rows![0].r).toMatchObject({ success: false });

    const [row] = await t.su<{ plan: string; status: string }>("select plan, status from entitlements where organization_id = $1", [org.id]);
    expect(row).toMatchObject({ plan: "business", status: "active" });
    const events = await t.su<{ event: string }>("select event from entitlement_events where organization_id = $1", [org.id]);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["code.failed", "code.redeemed"]));
  });

  it("the plan is the owner's to see, and codes are nobody's to read", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Private Co");
    const member = await addMember(t, org, "employee", "Worker");
    expect((await t.as(org.owner.authId, "select public.get_prosm_time_plan_status()")).error).toBeNull();
    expect((await t.as(member.authId, "select public.get_prosm_time_plan_status()")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select * from activation_codes")).error).not.toBeNull();
  });
});

describe("a trial that becomes paid", () => {
  it("leaves the trial state", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Convert Co");
    await t.su("update license_activation_state set is_trial = true where organization_id = $1", [org.id]);
    expect((await t.su<{ status: string }>("select status from entitlements where organization_id = $1", [org.id]))[0].status).toBe("trial");
    await t.su("update license_activation_state set is_trial = false, expires_at = now() + interval '1 year' where organization_id = $1", [org.id]);
    const [row] = await t.su<{ plan: string; status: string }>("select plan, status from entitlements where organization_id = $1", [org.id]);
    expect(row).toMatchObject({ plan: "legacy", status: "active" });
  });
});
