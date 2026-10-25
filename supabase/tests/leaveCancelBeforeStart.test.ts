// v2.3.43 step 8 (item 20): an approved leave can be cancelled only before
// its first day - the day before works; the day itself, after it, and a
// multi-day leave that started yesterday do not; the Owner is no exception.
// Migration 20261025170000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let worker: TestMember;
let manager: TestMember;

// "today" in Cairo, shifted by `days`.
const cairoDay = async (days: number) =>
  (await t.su<{ d: string }>("select ((now() at time zone 'Africa/Cairo')::date + $1::int)::text as d", [days]))[0].d;

async function approvedLeave(from: number, to: number) {
  const [start, end] = [await cairoDay(from), await cairoDay(to)];
  const [row] = await t.su<{ id: string }>(
    "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status, reviewed_by, reviewed_at) values ($1, $2, 'annual', $3, $4, ($4::date - $3::date) + 1, 'approved', $5, now()) returning id",
    [org.id, worker.userId, start, end, manager.userId],
  );
  return row.id;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Fayoum");
  const site = await createSite(t, org, "Oasis");
  worker = await addMember(t, org, "employee", "Laila Nabil");
  manager = await addMember(t, org, "manager", "Oasis Manager");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
});

describe("approved leave is cancelled only before it starts (item 20)", () => {
  it("the day before: the employee cancels it, the balance comes back, it is audited", async () => {
    const id = await approvedLeave(1, 2);
    expect((await t.as(worker.authId, "select public.cancel_prosm_time_leave_request($1)", [id])).error).toBeNull();
    const [{ status }] = await t.su<{ status: string }>("select status from leave_requests where id = $1", [id]);
    expect(status).toBe("cancelled");
    expect(await t.su("select id from audit_logs where action = 'leave.approved_cancelled' and entity_id = $1", [id])).toHaveLength(1);
  });

  it("the day itself: refused for the employee and for the manager", async () => {
    const id = await approvedLeave(0, 0);
    expect((await t.as(worker.authId, "select public.cancel_prosm_time_leave_request($1)", [id])).error).toMatch(/HAS STARTED/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'rejected', 'x')", [id])).error).toMatch(/HAS STARTED/);
  });

  it("after it, and a multi-day leave that started yesterday: refused", async () => {
    const past = await approvedLeave(-3, -2);
    const running = await approvedLeave(-1, 3);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'rejected', 'x')", [past])).error).toMatch(/HAS STARTED/);
    expect((await t.as(worker.authId, "select public.cancel_prosm_time_leave_request($1)", [running])).error).toMatch(/HAS STARTED/);
  });

  it("the Owner is no exception; before the start the manager can still revoke", async () => {
    const started = await approvedLeave(0, 1);
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'rejected', 'x')", [started])).error).toMatch(/HAS STARTED/);
    const future = await approvedLeave(5, 6);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'rejected', 'project needs')", [future])).error).toBeNull();
  });

  it("the approved list says which ones can still be cancelled", async () => {
    const rows = await t.as<{ id: string; start_date: string; can_cancel: boolean }>(manager.authId, "select * from public.list_prosm_time_approved_leave_requests(true)");
    expect(rows.error).toBeNull();
    const today = await cairoDay(0);
    for (const row of rows.rows ?? []) expect(row.can_cancel).toBe(row.start_date > today);
    expect(rows.rows?.some((row) => !row.can_cancel)).toBe(true);
  });
});
