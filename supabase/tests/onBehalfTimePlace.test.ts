// v2.3.43 step 10 (item 9): on-behalf clock in/out with a time the manager
// sets and a place name when there is no site; reason required; not refused
// by the site's blocks; listed in the managerOverrides report.
// Migration 20261025190000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;
let manager: TestMember;

const ago = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();
const clockIn = (member: TestMember, siteId: string | null, at: string | null, label: string | null, reason = "phone battery died") =>
  t.as(member.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, $3, null, $4, null, null, null, null, $5, $6)", [
    worker.userId, siteId, reason, randomUUID(), at, label,
  ]);
const clockOut = (member: TestMember, at: string | null) =>
  t.as(member.authId, "select public.admin_clock_out_prosm_time_attendance($1, 'forgot', $2, null, null, null, null, $3, null)", [worker.userId, randomUUID(), at]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Ismailia");
  site = await createSite(t, org, "Dock");
  worker = await addMember(t, org, "employee", "Tarek Samy");
  manager = await addMember(t, org, "manager", "Dock Manager");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  // A blocking site: late after a midnight shift start, outside-area BLOCK.
  await t.su("update sites set timezone = 'UTC', shift_start_time = '00:00', grace_tolerance_minutes = 0, block_self_clock_in_after_grace = true, outside_zone_policy = 'BLOCK' where id = $1", [site]);
});

describe("on-behalf time and place (item 9)", () => {
  it("clocks in at the time the manager sets, past the site's blocks, audited with both times", async () => {
    expect((await clockIn(manager, site, ago(3), null)).error).toBeNull();
    const [row] = await t.su<{ hours: number }>("select extract(epoch from (now() - clock_in_at)) / 3600 as hours from attendance_sessions where user_id = $1 and status = 'clocked_in'", [worker.userId]);
    expect(Number(row.hours)).toBeCloseTo(3, 1);
    const [audit] = await t.su<{ context: { timeSetByManager: boolean } }>("select context from audit_logs where action = 'ADMIN_CLOCK_IN_ON_BEHALF'");
    expect(audit.context.timeSetByManager).toBe(true);
  });

  it("clocks out at a set time after the clock-in, never before it", async () => {
    expect((await clockOut(manager, ago(4))).error).toMatch(/AFTER THE CLOCK-IN/);
    expect((await clockOut(manager, ago(1))).error).toBeNull();
    const [row] = await t.su<{ hours: number }>("select extract(epoch from (clock_out_at - clock_in_at)) / 3600 as hours from attendance_sessions where user_id = $1", [worker.userId]);
    expect(Number(row.hours)).toBeCloseTo(2, 1);
  });

  it("refuses a time overlapping a recorded shift, in the future, or older than 7 days", async () => {
    expect((await clockIn(manager, site, ago(2), null)).error).toMatch(/OVERLAPS/);
    expect((await clockIn(manager, site, new Date(Date.now() + 3600000).toISOString(), null)).error).toMatch(/LAST 7 DAYS/);
    expect((await clockIn(manager, site, ago(24 * 8), null)).error).toMatch(/LAST 7 DAYS/);
  });

  it("no site: a place name is required and kept", async () => {
    expect((await clockIn(manager, null, null, null)).error).toMatch(/WORKPLACE NAME/);
    expect((await clockIn(manager, null, null, "Client office, Cairo")).error).toBeNull();
    const [row] = await t.su<{ label: string }>("select manual_location_label as label from attendance_sessions where user_id = $1 and status = 'clocked_in'", [worker.userId]);
    expect(row.label).toBe("Client office, Cairo");
    expect((await clockOut(manager, null)).error).toBeNull();
  });

  it("a reason is required, and the managerOverrides report lists the actions", async () => {
    expect((await clockIn(manager, site, null, null, "  ")).error).toMatch(/REASON/);
    const today = new Date().toISOString().slice(0, 10);
    const report = await t.as<{ action: string }>(org.owner.authId, "select * from public.list_prosm_time_report_manager_overrides($1, $1)", [today]);
    expect(report.error).toBeNull();
    expect(report.rows!.filter((row) => row.action === "ADMIN_CLOCK_IN_ON_BEHALF").length).toBeGreaterThanOrEqual(2);
  });
});
