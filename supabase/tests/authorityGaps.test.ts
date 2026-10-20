// Workflow audit, owner 2026-10-20: timesheet and allowance approval, on-behalf
// clock-in and scheduling follow "only people below you, at sites you manage";
// allowance decisions are kept and told. Migration 20261020180000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let peerA: TestMember;
let managerB: TestMember;
let employee: TestMember;

const PERMISSIONS = ["timesheets.approve", "allowances.approve", "schedules.manage", "attendance.clock_in_on_behalf", "attendance.clock_out_on_behalf"];

async function siteManager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  for (const key of PERMISSIONS) {
    await t.su(
      "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = $2 on conflict do nothing",
      [member.userId, key],
    );
  }
  return member;
}

const submittedTimesheet = async (member: TestMember, month: number) =>
  (
    await t.su<{ id: string }>(
      "insert into timesheets (organization_id, user_id, period_start, period_end, status, submitted_at) values ($1, $2, make_date(2026, $3, 1), make_date(2026, $3, 28), 'submitted', now()) returning id",
      [org.id, member.userId, month],
    )
  )[0].id;
const approveTimesheet = (caller: TestMember, id: string, action = "approved", notes: string | null = null) =>
  t.as(caller.authId, "select public.approve_prosm_time_timesheet($1, $2, $3)", [id, action, notes]);

const draftAllowance = async (member: TestMember, day: string) =>
  (
    await t.su<{ id: string }>(
      "insert into allowance_entries (organization_id, user_id, entry_date, meal_allowance) values ($1, $2, $3, 50) returning id",
      [org.id, member.userId, day],
    )
  )[0].id;
const notifications = (member: TestMember, type: string) =>
  t.su<{ data: Record<string, unknown> }>("select data from notifications where user_id = $1 and type = $2", [member.userId, type]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("Manager A", siteA);
  peerA = await siteManager("Peer A", siteA);
  managerB = await siteManager("Manager B", siteB);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, siteA, employee);
  await assignToSite(t, siteB, employee);
});

describe("timesheet approval (C1)", () => {
  it("never lets a manager approve their own timesheet or a peer's", async () => {
    expect((await approveTimesheet(managerA, await submittedTimesheet(managerA, 1))).error).toMatch(/NOT AUTHORIZED/);
    expect((await approveTimesheet(managerA, await submittedTimesheet(peerA, 1))).error).toMatch(/NOT AUTHORIZED/);
  });

  it("lets the employee's manager decide, and passes the note to the employee", async () => {
    const id = await submittedTimesheet(employee, 2);
    expect((await approveTimesheet(managerA, id, "rejected", "Missing Thursday")).error).toBeNull();
    const [told] = await notifications(employee, "timesheet_rejected");
    expect(told.data.notes).toBe("Missing Thursday");
  });
});

describe("allowances (C2)", () => {
  it("tells only the employee's approvers when allowances are submitted", async () => {
    const id = await draftAllowance(employee, "2026-03-01");
    expect((await t.as(employee.authId, "select public.submit_prosm_time_allowance_entry($1)", [id])).error).toBeNull();
    expect(await notifications(managerA, "allowance_submitted")).toHaveLength(1);
    expect(await notifications(org.owner, "allowance_submitted")).toHaveLength(1);
    expect(await notifications(employee, "allowance_submitted")).toHaveLength(0);

    const own = await draftAllowance(managerA, "2026-03-01");
    await t.as(managerA.authId, "select public.submit_prosm_time_allowance_entry($1)", [own]);
    // A fellow manager is told of the employee's entry only, never of a peer's.
    expect(await notifications(peerA, "allowance_submitted")).toHaveLength(1);
    expect(await notifications(managerA, "allowance_submitted")).toHaveLength(1);
  });

  it("refuses a manager deciding their own or a peer's allowances", async () => {
    const [own] = await t.su<{ id: string }>("select id from allowance_entries where user_id = $1", [managerA.userId]);
    expect((await t.as(managerA.authId, "select public.approve_prosm_time_allowance_entry($1, 'approved')", [own.id])).error).toMatch(/AUTHORITY REQUIRED/);
    expect((await t.as(peerA.authId, "select public.approve_prosm_time_allowance_entry($1, 'approved')", [own.id])).error).toMatch(/AUTHORITY REQUIRED/);
  });

  it("keeps a rejection with its reason, tells the employee, and lets them send it again", async () => {
    const [entry] = await t.su<{ id: string }>("select id from allowance_entries where user_id = $1", [employee.userId]);
    expect((await t.as(managerA.authId, "select public.approve_prosm_time_allowance_entry($1, 'rejected', 'No receipt')", [entry.id])).error).toBeNull();
    const [row] = await t.su<{ status: string; review_notes: string }>("select status, review_notes from allowance_entries where id = $1", [entry.id]);
    expect(row).toEqual({ status: "rejected", review_notes: "No receipt" });
    const [told] = await notifications(employee, "allowance_rejected");
    expect(told.data.notes).toBe("No receipt");
    expect((await t.as(employee.authId, "select public.submit_prosm_time_allowance_entry($1)", [entry.id])).error).toBeNull();
  });
});

describe("on-behalf clock-in (C3) and scheduling (I10)", () => {
  it("refuses clocking someone in at a site the manager does not manage", async () => {
    const result = await t.as(managerA.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, 'forgot phone')", [employee.userId, siteB]);
    expect(result.error).toMatch(/DO NOT MANAGE THIS SITE/);
  });

  it("lets a manager clock in and out at their own site", async () => {
    expect((await t.as(managerA.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, 'forgot phone')", [employee.userId, siteA])).error).toBeNull();
    expect((await t.as(managerB.authId, "select public.admin_clock_out_prosm_time_attendance($1, 'forgot phone')", [employee.userId])).error).toMatch(/DO NOT MANAGE/);
    expect((await t.as(managerA.authId, "select public.admin_clock_out_prosm_time_attendance($1, 'forgot phone')", [employee.userId])).error).toBeNull();
  });

  it("refuses scheduling a peer, or anyone on their approved leave", async () => {
    const assign = (caller: TestMember, subject: TestMember, day: string) =>
      t.as(caller.authId, "select public.assign_prosm_time_shift($1, $2, $3, '08:00', '16:00')", [subject.userId, siteA, day]);
    expect((await assign(managerA, peerA, "2026-11-02")).error).toMatch(/BELOW YOUR ROLE/);
    await t.su(
      "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', '2026-11-03', '2026-11-04', 2, 'approved')",
      [org.id, employee.userId],
    );
    expect((await assign(managerA, employee, "2026-11-03")).error).toMatch(/ON APPROVED LEAVE/);
    expect((await assign(managerA, employee, "2026-11-02")).error).toBeNull();
  });
});
