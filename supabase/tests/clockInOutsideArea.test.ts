// Audit 2026-10-12, item 2.1 (T57), owner decision option (a): a site can
// refuse a self clock-in from outside its work area. Migration 20261013190000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let factory: string;
let otherSite: string;
let mona: TestMember;
let exempt: TestMember;
let otherManager: TestMember;

const far = { latitude: 30.0212, longitude: 31.7581 }; // ~30 km from the factory

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  factory = await createSite(t, org, "Factory 10th of Ramadan", { latitude: 30.2961, longitude: 31.7458, radius: 150 });
  otherSite = await createSite(t, org, "Tower B");
  await t.su("update sites set geofence_required = true where id = $1", [factory]);
  mona = await addMember(t, org, "employee", "Mona Elsayed");
  exempt = await addMember(t, org, "employee", "Exempt Ali");
  for (const member of [mona, exempt]) await assignToSite(t, factory, member);
  await t.su("update site_assignments set is_exempt_from_restrictions = true where user_id = $1", [exempt.userId]);
  otherManager = await addMember(t, org, "manager", "Tower Manager");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [otherSite, otherManager.userId]);
});

describe("block self clock-in outside the work area (audit 2.1)", () => {
  it("is off by default: the clock-in is recorded with an exception, as before", async () => {
    expect((await clockIn(t, mona, factory, far)).error).toBeNull();
    await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = $1", [mona.userId]);
  });

  it("only the Owner or the site's own manager can turn it on", async () => {
    expect((await t.as(otherManager.authId, "select public.set_prosm_time_site_block_clock_in_outside($1, true)", [factory])).error).toMatch(/AUTHORITY/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_site_block_clock_in_outside($1, true)", [factory])).error).toBeNull();
  });

  it("then refuses a self clock-in 30 km away, but not an exempt employee or one inside the area", async () => {
    expect((await clockIn(t, mona, factory, far)).error).toMatch(/CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER/);
    expect((await clockIn(t, exempt, factory, far)).error).toBeNull();
    expect((await clockIn(t, mona, factory, { latitude: 30.29612, longitude: 31.74582 })).error).toBeNull();
  });
});
