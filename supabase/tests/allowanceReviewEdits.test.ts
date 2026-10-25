// v2.3.43 step 5 (item 21): a manager authorised for it edits allowance lines
// of a sheet in review, at their own sites, with a reason (audited); totals
// follow; recalculation keeps the manager's value; no edit after approval
// except through reopening. Migration 20261025140000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let otherSite: string;
let worker: TestMember;
let manager: TestMember;
let otherManager: TestMember;
let supervisor: TestMember;
let sheetId: string;
let entryId: string;

const sheetTotal = async () => Number((await t.su<{ total: string }>("select total from allowance_sheets where id = $1", [sheetId]))[0].total);
const adjust = (member: TestMember, field: string, value: number, reason = "receipt checked") =>
  t.as(member.authId, "select public.adjust_prosm_time_allowance_entry($1, $2, $3, $4)", [entryId, field, value, reason]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Suez");
  site = await createSite(t, org, "Port");
  otherSite = await createSite(t, org, "Canal");
  worker = await addMember(t, org, "employee", "Omar Fathy");
  manager = await addMember(t, org, "manager", "Port Manager");
  otherManager = await addMember(t, org, "manager", "Canal Manager");
  supervisor = await addMember(t, org, "supervisor", "Port Supervisor");
  for (const member of [worker, supervisor]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [otherSite, otherManager.userId]);
  // These tests are about the amounts: overtime counts without a manager's approval (step 6 default is "approval").
  await t.su("insert into overtime_policies (organization_id, approval_mode) values ($1, 'automatic')", [org.id]);
  await t.su("update sites set timezone = 'Africa/Cairo', overtime_start_time = '17:00' where id = $1", [site]);
  await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [site, JSON.stringify({ overtimeHour: 100, meal: 50, transportation: 30 })]);
  await t.su(
    `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
     values ($1, $2, $3, 'clocked_out', '2026-10-25 09:00'::timestamp at time zone 'Africa/Cairo', '2026-10-25 18:00'::timestamp at time zone 'Africa/Cairo')`,
    [org.id, worker.userId, site],
  );
  expect((await t.as(worker.authId, "select public.upsert_prosm_time_allowance_entry('2026-10-25')")).error).toBeNull();
  expect((await t.as(worker.authId, "select public.submit_prosm_time_allowances('2026-10-01', '2026-10-31')")).error).toBeNull();
  [{ id: sheetId }] = await t.su<{ id: string }>("select id from allowance_sheets where user_id = $1", [worker.userId]);
  [{ id: entryId }] = await t.su<{ id: string }>("select id from allowance_entries where user_id = $1", [worker.userId]);
});

describe("editing allowances during review (item 21)", () => {
  it("the sheet starts at 50 + 30 + 100 (1 h overtime) = 180", async () => {
    expect(await sheetTotal()).toBe(180);
  });

  it("refuses people without the permission, managers of other sites, and a missing reason", async () => {
    expect((await adjust(supervisor, "meal", 40)).error).toMatch(/EDIT_DURING_REVIEW/);
    expect((await adjust(otherManager, "meal", 40)).error).toMatch(/DO NOT MANAGE/);
    expect((await adjust(manager, "meal", 40, "")).error).toMatch(/REASON/);
    expect((await adjust(manager, "meal", -1)).error).toMatch(/NEGATIVE/);
  });

  it("the site's manager changes the meal to 40 and the overtime to 75: totals follow, lines marked, audited", async () => {
    expect((await adjust(manager, "meal", 40)).error).toBeNull();
    expect((await adjust(manager, "overtime", 75, "left at 17:45")).error).toBeNull();
    expect(await sheetTotal()).toBe(145);
    const [row] = await t.su<{ manual_overrides: Record<string, { value: number; original: number }> }>("select manual_overrides from allowance_entries where id = $1", [entryId]);
    expect(row.manual_overrides.meal.value).toBe(40);
    expect(row.manual_overrides.meal.original).toBe(50);
    expect(row.manual_overrides.overtime.original).toBe(100);
    const audits = await t.su<{ previous_state: { value: number }; new_state: { value: number }; reason: string }>(
      "select previous_state, new_state, reason from audit_logs where action = 'allowances.edit_during_review' order by created_at",
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].previous_state.value).toBe(50);
    expect(audits[0].new_state.value).toBe(40);
    expect(audits[1].reason).toBe("left at 17:45");
    expect(await t.su("select id from allowance_entry_adjustments where entry_id = $1", [entryId])).toHaveLength(2);
  });

  it("a recalculation keeps the manager's values", async () => {
    await t.su("select public.prosm_time_refresh_allowance_entry($1)", [entryId]);
    expect(await sheetTotal()).toBe(145);
  });

  it("setting a line back to its original value clears the mark", async () => {
    expect((await adjust(manager, "meal", 50, "my mistake")).error).toBeNull();
    const [row] = await t.su<{ manual_overrides: Record<string, unknown> }>("select manual_overrides from allowance_entries where id = $1", [entryId]);
    expect(Object.keys(row.manual_overrides)).toEqual(["overtime"]);
    expect(await sheetTotal()).toBe(155);
  });

  it("after approval nothing changes, and only the Owner reopens (with a reason)", async () => {
    expect((await t.as(manager.authId, "select public.review_prosm_time_allowance_sheet($1, 'approved')", [sheetId])).error).toBeNull();
    expect((await adjust(manager, "meal", 10)).error).toMatch(/ALREADY APPROVED/);
    expect((await t.as(manager.authId, "select public.reopen_prosm_time_allowance_sheet($1, 'fix')", [sheetId])).error).toMatch(/REOPEN_APPROVED/);
    expect((await t.as(org.owner.authId, "select public.reopen_prosm_time_allowance_sheet($1, '')", [sheetId])).error).toMatch(/REASON/);
    expect((await t.as(org.owner.authId, "select public.reopen_prosm_time_allowance_sheet($1, 'wrong site prices')", [sheetId])).error).toBeNull();
    const [{ status }] = await t.su<{ status: string }>("select status from allowance_sheets where id = $1", [sheetId]);
    expect(status).toBe("submitted");
    expect((await adjust(manager, "meal", 45, "corrected after reopening")).error).toBeNull();
    expect(await sheetTotal()).toBe(150);
    expect(await t.su("select id from audit_logs where action = 'allowances.reopen_approved'")).toHaveLength(1);
  });
});
