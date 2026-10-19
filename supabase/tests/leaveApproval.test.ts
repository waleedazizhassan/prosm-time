// Owner 2026-10-19: approving leave is its own permission (Managers and the
// Owner, not Supervisors), strictly per site, never one's own; the workers'
// kiosk is run by the Owner or the site's Manager. Migration 20261019130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let managerB: TestMember;
let supervisorA: TestMember;
let employeeA: TestMember;

async function siteManager(role: string, name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, role, name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

const requestLeave = async (member: TestMember) => {
  const result = await t.as(member.authId, "select public.request_prosm_time_leave('annual', current_date + 40, current_date + 41, 'Trip')");
  if (result.error) throw new Error(result.error);
  const [row] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [member.userId]);
  return row.id;
};
const review = (member: TestMember, id: string) => t.as(member.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [id]);
const notified = async (member: TestMember, requestId: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and related_entity_id = $2", [member.userId, requestId]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("manager", "Manager A", siteA);
  managerB = await siteManager("manager", "Manager B", siteB);
  supervisorA = await siteManager("supervisor", "Supervisor A", siteA);
  employeeA = await addMember(t, org, "employee", "Employee A");
  await assignToSite(t, siteA, employeeA);
});

describe("leave approval is its own permission, per site", () => {
  it("is given to Managers and the Owner, not Supervisors", async () => {
    const holders = await t.su<{ role_key: string }>(
      "select r.role_key from role_default_permissions rdp join roles r on r.id = rdp.role_id join permissions p on p.id = rdp.permission_id where p.permission_key = 'leave.approve' order by 1",
    );
    expect(holders.map((row) => row.role_key)).toEqual(["manager", "owner"]);
  });

  it("lets only the Manager of the person's site decide, and tells only them", async () => {
    const id = await requestLeave(employeeA);
    expect(await notified(managerA, id)).toBe(1);
    expect(await notified(supervisorA, id)).toBe(0);
    expect(await notified(managerB, id)).toBe(0);
    expect((await review(supervisorA, id)).error).toMatch(/NOT AUTHORIZED TO REVIEW LEAVE/);
    expect((await review(managerB, id)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await review(managerA, id)).error).toBeNull();
  });

  it("sends a Manager's own leave to the Owner; the Manager cannot approve it", async () => {
    const id = await requestLeave(managerA);
    expect(await notified(org.owner, id)).toBe(1);
    expect((await review(managerA, id)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await review(org.owner, id)).error).toBeNull();
  });
});

describe("workers' kiosk", () => {
  it("is run by the Owner or the site's Manager only", async () => {
    const created = await t.as<{ r: { workerNumber: string } }>(org.owner.authId, "select public.create_prosm_time_external_worker('Hany Said', null) as r");
    const number = created.rows?.[0].r.workerNumber ?? "";
    const clockIn = (member: TestMember, siteId: string) => t.as(member.authId, "select public.kiosk_worker_clock_in($1, $2, 30.02, 31.75)", [siteId, number]);
    expect((await clockIn(employeeA, siteA)).error).toMatch(/ONLY THE OWNER OR THE SITES MANAGER/);
    expect((await clockIn(supervisorA, siteA)).error).toMatch(/ONLY THE OWNER OR THE SITES MANAGER/);
    expect((await clockIn(managerB, siteA)).error).toMatch(/ONLY THE OWNER OR THE SITES MANAGER/);
    expect((await clockIn(managerA, siteA)).error).toBeNull();
  });
});
