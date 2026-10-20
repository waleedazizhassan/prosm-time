// Owner 2026-10-20: a break never outlives its shift, whichever way the
// shift ends. Migration 20261020120000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let employee: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, siteId, employee);
});

describe("breaks end with the shift", () => {
  it("ends an open break when the shift is clocked out on the person's behalf", async () => {
    expect((await clockIn(t, employee, siteId)).error).toBeNull();
    const sessionId = await openSessionId(t, employee);
    await t.su("insert into break_events (organization_id, attendance_session_id, user_id, paid) values ($1, $2, $3, false)", [org.id, sessionId, employee.userId]);
    expect((await t.as(org.owner.authId, "select public.admin_clock_out_prosm_time_attendance($1, 'left without clocking out')", [employee.userId])).error).toBeNull();
    const [row] = await t.su<{ status: string; ended: boolean }>(
      "select b.status, b.ended_at = s.clock_out_at as ended from break_events b join attendance_sessions s on s.id = b.attendance_session_id where b.attendance_session_id = $1",
      [sessionId],
    );
    expect(row).toEqual({ status: "ended", ended: true });
  });
});
