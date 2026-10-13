// Audit 2026-10-12, item 4.5 - SOS alerts reach the site's own managers
// and the Owner, not managers of other sites. Migration 20261013160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let towerManager: TestMember;
let factoryManager: TestMember;
let worker: TestMember;
let coworker: TestMember;

const sosNotifications = async (member: TestMember) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'sos_alert'", [member.userId]))[0].n;
const visibleAlerts = async (member: TestMember) =>
  (await t.as<{ site_name: string }>(member.authId, "select site_name from sos_alerts where user_id = $1", [worker.userId])).rows ?? [];

async function siteManager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const tower = await createSite(t, org, "Tower B");
  const factory = await createSite(t, org, "Factory");
  towerManager = await siteManager("Tower Manager", tower);
  factoryManager = await siteManager("Factory Manager", factory);
  worker = await addMember(t, org, "employee", "Omar Hassan");
  coworker = await addMember(t, org, "employee", "Ali Coworker");
  for (const member of [worker, coworker]) await assignToSite(t, tower, member);
  for (const member of [worker, coworker]) {
    const result = await clockIn(t, member, tower);
    if (result.error) throw new Error(result.error);
  }
  const result = await t.as(worker.authId, "select public.trigger_prosm_time_shift_sos_alert($1, 30.02, 31.75, 8)", [await openSessionId(t, worker)]);
  if (result.error) throw new Error(result.error);
});

describe("SOS recipients (audit 4.5)", () => {
  it("notifies the site's manager, the Owner and the co-worker on site", async () => {
    expect(await sosNotifications(towerManager)).toBe(1);
    expect(await sosNotifications(org.owner)).toBe(1);
    expect(await sosNotifications(coworker)).toBe(1);
  });

  it("does not notify a manager of another site", async () => {
    expect(await sosNotifications(factoryManager)).toBe(0);
  });

  it("shows the alert, with its site, to the site's manager and the Owner only", async () => {
    expect(await visibleAlerts(towerManager)).toEqual([{ site_name: "Tower B" }]);
    expect(await visibleAlerts(org.owner)).toEqual([{ site_name: "Tower B" }]);
    expect(await visibleAlerts(factoryManager)).toEqual([]);
  });
});
