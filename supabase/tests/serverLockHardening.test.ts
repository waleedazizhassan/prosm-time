// v2.3.55 (owner 2026-10-27, security review: "the server refuses, not the
// screen"): an ended or suspended paid licence locks like an ended trial; a
// deactivated account reads nothing; read-only tables take no writes.
// Migration 20261027170000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg, createSite } from "./support/fixtures";

describe("server lock", () => {
  it("an ended paid licence locks the organisation on the server, and a renewal reopens it", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Paid Co");
    await createSite(t, org, "Main");
    const worker = await addMember(t, org, "employee", "Worker");
    const visible = () => t.as<{ n: number }>(worker.authId, "select count(*)::int as n from organizations");
    expect((await visible()).rows![0].n).toBeGreaterThan(0);

    await t.su("update license_activation_state set is_trial = false, expires_at = now() - interval '1 day' where organization_id = $1", [org.id]);
    expect((await visible()).rows![0].n).toBe(0);
    const status = await t.as<{ s: { locked: boolean; licenseEnded: boolean } }>(org.owner.authId, "select public.get_prosm_time_trial_status() as s");
    expect(status.rows![0].s).toMatchObject({ locked: true, licenseEnded: true });

    await t.su("update license_activation_state set expires_at = now() + interval '1 year' where organization_id = $1", [org.id]);
    expect((await visible()).rows![0].n).toBeGreaterThan(0);
  });

  it("a suspended licence locks too", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Suspended Co");
    await createSite(t, org, "Main");
    await t.su("update license_activation_state set status = 'SUSPENDED' where organization_id = $1", [org.id]);
    expect((await t.as<{ n: number }>(org.owner.authId, "select count(*)::int as n from organizations")).rows![0].n).toBe(0);
  });

  it("a deactivated account reads nothing of the organisation", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Gone Co");
    await createSite(t, org, "Main");
    const leaver = await addMember(t, org, "employee", "Leaver");
    expect((await t.as<{ n: number }>(leaver.authId, "select count(*)::int as n from organizations")).rows![0].n).toBeGreaterThan(0);
    await t.su("update users set is_active = false where id = $1", [leaver.userId]);
    expect((await t.as<{ n: number }>(leaver.authId, "select count(*)::int as n from organizations")).rows![0].n).toBe(0);
    expect((await t.as<{ n: number }>(leaver.authId, "select count(*)::int as n from leave_types")).rows![0].n).toBe(0);
  });

  it("tables whose rules only allow reading take no writes from the app", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Grants Co");
    const result = await t.as(org.owner.authId, "delete from legal_acknowledgements");
    expect(result.error).toMatch(/permission denied/);
  });
});
