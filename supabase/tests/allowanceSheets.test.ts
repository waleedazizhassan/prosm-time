// Owner 2026-10-20: every unsent allowance day goes to the manager as one
// sheet, decided in one go. Migration 20261020280000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let peer: TestMember;
let employee: TestMember;

const day = (member: TestMember, date: string, meal: number) =>
  t.su("insert into allowance_entries (organization_id, user_id, entry_date, meal_allowance) values ($1, $2, $3, $4)", [org.id, member.userId, date, meal]);
const told = async (member: TestMember, type: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = $2", [member.userId, type]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const siteId = await createSite(t, org, "Capital");
  manager = await addMember(t, org, "manager", "Mona");
  peer = await addMember(t, org, "manager", "Peer");
  for (const member of [manager, peer]) await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  employee = await addMember(t, org, "employee", "Hana");
  await assignToSite(t, siteId, employee);
  await day(employee, "2026-03-01", 50);
  await day(employee, "2026-03-02", 70);
  await day(employee, "2026-03-03", 30);
});

describe("allowance sheets", () => {
  let sheetId: string;

  it("sends every unsent day as one sheet, with one notice", async () => {
    const sent = await t.as<{ r: { sent: number; sheetId: string } }>(employee.authId, "select public.submit_prosm_time_allowances('2026-03-01', '2026-03-31') as r");
    expect(sent.error).toBeNull();
    expect(sent.rows![0].r.sent).toBe(3);
    sheetId = sent.rows![0].r.sheetId;
    const [sheet] = await t.su<{ days: number; total: string; status: string }>("select days, total, status from allowance_sheets where id = $1", [sheetId]);
    expect(sheet).toEqual({ days: 3, total: "150.00", status: "submitted" });
    expect(await told(manager, "allowance_submitted")).toBe(1);
    expect((await t.as(employee.authId, "select public.submit_prosm_time_allowances('2026-03-01', '2026-03-31')")).error).toMatch(/NO ALLOWANCES TO SEND/);
  });

  it("decides the whole sheet at once, never a day of it alone", async () => {
    const [entry] = await t.su<{ id: string }>("select id from allowance_entries where sheet_id = $1 limit 1", [sheetId]);
    expect((await t.as(manager.authId, "select public.approve_prosm_time_allowance_entry($1, 'approved')", [entry.id])).error).toMatch(/WHOLE ALLOWANCE SHEET/);
    expect((await t.as(employee.authId, "select public.review_prosm_time_allowance_sheet($1, 'approved')", [sheetId])).error).toMatch(/AUTHORITY REQUIRED/);

    expect((await t.as(manager.authId, "select public.review_prosm_time_allowance_sheet($1, 'rejected', 'Receipts missing')", [sheetId])).error).toBeNull();
    const statuses = await t.su<{ status: string; review_notes: string }>("select distinct status, review_notes from allowance_entries where sheet_id = $1", [sheetId]);
    expect(statuses).toEqual([{ status: "rejected", review_notes: "Receipts missing" }]);
    expect(await told(employee, "allowance_rejected")).toBe(1);

    // Rejected days go back with the next sheet.
    const again = await t.as<{ r: { sent: number } }>(employee.authId, "select public.submit_prosm_time_allowances('2026-03-01', '2026-03-31') as r");
    expect(again.rows![0].r.sent).toBe(3);
  });

  it("shows a sheet to the employee and their reviewers only", async () => {
    const seen = async (member: TestMember) => (await t.as<{ n: number }>(member.authId, "select count(*)::int as n from allowance_sheets")).rows![0].n;
    expect(await seen(employee)).toBe(2);
    expect(await seen(manager)).toBe(2);
    const outsider = await addMember(t, org, "employee", "Omar");
    expect(await seen(outsider)).toBe(0);
  });
});
