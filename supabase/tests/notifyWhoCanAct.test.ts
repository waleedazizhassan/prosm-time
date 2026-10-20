// Owner 2026-10-20: a reason for being outside the work area is notified
// only to whoever can decide it. Migration 20261020130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let managerA: TestMember;
let supervisorA: TestMember;
let managerB: TestMember;
let employee: TestMember;

async function siteManager(role: string, name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, role, name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

// A clock-in at the site with an open "outside the area" exception, then the person's reason.
async function reasonFrom(member: TestMember): Promise<string> {
  const result = await clockIn(t, member, siteA);
  if (result.error) throw new Error(result.error);
  const [event] = await t.su<{ id: string }>("select id from attendance_events where user_id = $1 and event_type = 'clock_in' order by occurred_at desc limit 1", [member.userId]);
  const [exception] = await t.su<{ id: string }>(
    "insert into geofence_exceptions (organization_id, user_id, attendance_event_id, status, distance_meters) values ($1, $2, $3, 'pending_reason', 400) returning id",
    [org.id, member.userId, event.id],
  );
  const submitted = await t.as(member.authId, "select public.submit_prosm_time_exception_reason($1, 'work_assignment', 'Delivering materials')", [exception.id]);
  if (submitted.error) throw new Error(submitted.error);
  return exception.id;
}
const told = async (member: TestMember, id: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and related_entity_id = $2", [member.userId, id]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  const siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("manager", "Manager A", siteA);
  supervisorA = await siteManager("supervisor", "Supervisor A", siteA);
  managerB = await siteManager("manager", "Manager B", siteB);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, siteA, employee);
});

describe("notifications go to whoever can act", () => {
  it("tells the site's manager, its supervisor and the Owner - not another site's manager", async () => {
    const id = await reasonFrom(employee);
    expect(await told(managerA, id)).toBe(1);
    expect(await told(supervisorA, id)).toBe(1);
    expect(await told(org.owner, id)).toBe(1);
    expect(await told(managerB, id)).toBe(0);
  });

  it("sends a manager's own reason to the Owner only", async () => {
    const id = await reasonFrom(managerA);
    expect(await told(managerA, id)).toBe(0);
    expect(await told(supervisorA, id)).toBe(0);
    expect(await told(org.owner, id)).toBe(1);
  });
});
