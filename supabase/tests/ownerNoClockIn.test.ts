// Owner 2026-10-18: the Owner does not clock in or out. Migration 20261018120000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let manager: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  manager = await addMember(t, org, "manager", "Mona Manager");
  await assignToSite(t, siteId, manager);
});

describe("the Owner does not clock in", () => {
  it("refuses the Owner's own clock-in", async () => {
    expect((await clockIn(t, org.owner, siteId)).error).toMatch(/THE OWNER DOES NOT CLOCK IN OR OUT/);
  });

  it("refuses clocking the Owner in on their behalf, even by the Owner", async () => {
    const asOwner = await t.as(org.owner.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, 'test', null, null, 30.02125, 31.75812, 8)", [org.owner.userId, siteId]);
    expect(asOwner.error).toMatch(/BELOW YOUR ROLE/);
  });

  it("still lets managers and employees clock in", async () => {
    expect((await clockIn(t, manager, siteId)).error).toBeNull();
  });
});
