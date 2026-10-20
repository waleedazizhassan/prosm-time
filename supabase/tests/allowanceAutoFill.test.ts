// Owner 2026-10-20: an employee may turn on auto-fill (each clocked-out day
// starts itself from the prices), sends a period's drafts to the manager in
// one go, and the Owner has no allowances. Migration 20261020270000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let manager: TestMember;
let employee: TestMember;

const entries = (member: TestMember) =>
  t.su<{ status: string; meal_allowance: string }>("select status, meal_allowance from allowance_entries where user_id = $1", [member.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Capital");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, manager.userId]);
  employee = await addMember(t, org, "employee", "Hana");
  await assignToSite(t, siteId, employee);
  await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, '{\"meal\": 60}'::jsonb)", [siteId]);
});

describe("allowance auto-fill", () => {
  it("does nothing on clock-out until the employee turns it on", async () => {
    await clockIn(t, employee, siteId);
    await clockOut(t, employee);
    expect(await entries(employee)).toHaveLength(0);
  });

  it("starts the day from the prices on clock-out once turned on, as a draft", async () => {
    expect((await t.as(employee.authId, "select public.set_prosm_time_allowance_auto_fill(true)")).error).toBeNull();
    await t.su("delete from attendance_sessions where user_id = $1", [employee.userId]);
    expect((await clockIn(t, employee, siteId)).error).toBeNull();
    expect((await clockOut(t, employee)).error).toBeNull();
    expect(await entries(employee)).toEqual([{ status: "draft", meal_allowance: "60.00" }]);
  });

  it("sends a period's drafts to the manager in one go", async () => {
    const sent = await t.as<{ r: { sent: number } }>(employee.authId, "select public.submit_prosm_time_allowances(current_date - 1, current_date + 1) as r");
    expect(sent.error).toBeNull();
    expect(sent.rows![0].r.sent).toBe(1);
    expect((await entries(employee))[0].status).toBe("submitted");
    const [told] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'allowance_submitted'", [manager.userId]);
    expect(told.n).toBe(1);
  });

  it("gives the Owner no allowances", async () => {
    expect((await t.as(org.owner.authId, "select public.upsert_prosm_time_allowance_entry(current_date)")).error).toMatch(/OWNER HAS NO ALLOWANCES/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_allowance_auto_fill(true)")).error).toMatch(/OWNER HAS NO ALLOWANCES/);
  });
});
