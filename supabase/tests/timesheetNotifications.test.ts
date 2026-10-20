// Owner 2026-10-20 (where does a timesheet go?): the employee is told when
// their timesheet is ready; a submitted one reaches only those who can
// approve it. Migration 20261020140000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let managerA: TestMember;
let managerB: TestMember;
let employee: TestMember;

async function siteManager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}
const told = async (member: TestMember, type: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = $2", [member.userId, type]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const siteA = await createSite(t, org, "Site A");
  const siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("Manager A", siteA);
  managerB = await siteManager("Manager B", siteB);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, siteA, employee);
});

describe("timesheet notifications", () => {
  it("tells the employee their timesheet is ready, and only the right people when it is submitted", async () => {
    const generated = await t.as<{ r: { timesheetId: string } }>(
      managerA.authId,
      "select public.generate_prosm_time_timesheet($1, date_trunc('month', current_date)::date, current_date) as r",
      [employee.userId],
    );
    expect(generated.error).toBeNull();
    expect(await told(employee, "timesheet_ready")).toBe(1);

    const submitted = await t.as(employee.authId, "select public.submit_prosm_time_timesheet($1)", [generated.rows?.[0].r.timesheetId]);
    expect(submitted.error).toBeNull();
    expect(await told(managerA, "timesheet_submitted")).toBe(1);
    expect(await told(org.owner, "timesheet_submitted")).toBe(1);
    expect(await told(managerB, "timesheet_submitted")).toBe(0);
  });
});
