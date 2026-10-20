// Workflow audit I5/I7, owner 2026-10-20: a correction request names the
// employee to the managers, and the reviewer's note reaches the employee.
// Migration 20261020230000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let employee: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const site = await createSite(t, org, "Site A");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, site, employee);
  expect((await clockIn(t, employee, site)).error).toBeNull();
  expect((await clockOut(t, employee)).error).toBeNull();
});

describe("corrections and review notes", () => {
  it("names the employee to the manager, and brings the manager's note back", async () => {
    const [shift] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [employee.userId]);
    const submitted = await t.as<{ r: { correctionRequestId: string } }>(
      employee.authId,
      "select public.submit_prosm_time_correction_request($1, 'clock_out', now() - interval '5 minutes', 'Forgot to clock out') as r",
      [shift.id],
    );
    expect(submitted.error).toBeNull();
    const requestId = submitted.rows?.[0].r.correctionRequestId;
    const [toManager] = await t.su<{ data: Record<string, unknown> }>("select data from notifications where user_id = $1 and related_entity_id = $2", [manager.userId, requestId]);
    expect(toManager.data).toMatchObject({ employeeName: "Lido", kind: "correction" });

    const reviewed = await t.as(manager.authId, "select public.review_prosm_time_exception('correction_request', $1, 'rejected', 'The gate log shows 17:00')", [requestId]);
    expect(reviewed.error).toBeNull();
    const [toEmployee] = await t.su<{ data: Record<string, unknown> }>(
      "select data from notifications where user_id = $1 and type = 'correction_reviewed'",
      [employee.userId],
    );
    expect(toEmployee.data).toMatchObject({ kind: "correction", notes: "The gate log shows 17:00" });
  });
});
