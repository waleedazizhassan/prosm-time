// Audit 2026-10-12, item 4.8 - one reason covers one trip outside the
// work area. Migration 20261013170000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let emp: TestMember;

const exceptions = () =>
  t.su<{ id: string; status: string; employee_reason: string | null }>("select id, status, employee_reason from geofence_exceptions where user_id = $1 order by created_at", [emp.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  emp = await addMember(t, org, "employee", "Omar Hassan");
  await assignToSite(t, siteId, emp);
});

describe("one reason per trip (audit 4.8)", () => {
  it("covers the clock-out and the clock-in of the same trip with one reason", async () => {
    expect((await clockIn(t, emp, siteId)).error).toBeNull();
    // Clock out ~3 km away, then clock in again from there.
    expect((await t.as(emp.authId, "select public.clock_out_prosm_time_attendance(gen_random_uuid()::text, null, 30.04, 31.78, 8)")).error).toBeNull();
    expect((await clockIn(t, emp, siteId, { latitude: 30.04, longitude: 31.78 })).error).toBeNull();
    const before = await exceptions();
    expect(before).toHaveLength(2);

    const result = await t.as(emp.authId, "select public.submit_prosm_time_exception_reason($1, 'work_assignment', 'Delivering parts to the client') as r", [before[0].id]);
    expect(result.error).toBeNull();

    const after = await exceptions();
    expect(after.map((row) => row.status)).toEqual(["pending_review", "pending_review"]);
    expect(after.map((row) => row.employee_reason)).toEqual(["Delivering parts to the client", "Delivering parts to the client"]);
    expect((await clockOut(t, emp)).error).toBeNull();
  });

  it("leaves another trip's exception waiting for its own reason", async () => {
    await t.su("update geofence_exceptions set created_at = created_at - interval '2 days' where user_id = $1", [emp.userId]);
    expect((await clockIn(t, emp, siteId, { latitude: 30.04, longitude: 31.78 })).error).toBeNull();
    const rows = await exceptions();
    expect(rows.at(-1)?.status).toBe("pending_reason");
  });
});
