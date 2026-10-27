// v2.3.54 (owner 2026-10-27): a manager turns an absence into leave - an
// approved leave recorded on the person's behalf, past dates included; the
// absence leaves the dashboard and a draft timesheet shows the leave.
// Migration 20261027110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let employee: TestMember;
let outsider: TestMember;

const cairoToday = "(now() at time zone 'Africa/Cairo')::date";
const grant = (member: TestMember, user: TestMember, start: string, end: string, type = "annual") =>
  t.as<{ r: { requestId: string; days: number; timesheetsUpdated: number; timesheetsToReopen: number } }>(
    member.authId,
    `select public.grant_prosm_time_leave($1, $2, ${start}, ${end}, 'Asked by phone') as r`,
    [user.userId, type],
  );

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Grant Co");
  const site = await createSite(t, org, "Main");
  const other = await createSite(t, org, "Other", { latitude: 30.4, longitude: 31.4 });
  manager = await addMember(t, org, "manager", "Mona Manager");
  employee = await addMember(t, org, "employee", "Omar Employee");
  outsider = await addMember(t, org, "employee", "Other Site");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await assignToSite(t, site, employee);
  await assignToSite(t, other, outsider);
});

describe("granting leave on someone's behalf", () => {
  it("turns today's absence into approved leave, notified and recorded as on their behalf", async () => {
    const result = await grant(manager, employee, cairoToday, cairoToday);
    expect(result.error).toBeNull();
    const [row] = await t.su<{ status: string; recorded_by: string; reviewed_by: string }>("select status, recorded_by, reviewed_by from leave_requests where id = $1", [result.rows![0].r.requestId]);
    expect(row).toEqual({ status: "approved", recorded_by: manager.userId, reviewed_by: manager.userId });
    const [note] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'correction_reviewed'", [employee.userId]);
    expect(note.n).toBe(1);

    const dash = await t.as<{ d: { kpi: { onLeaveToday: number }; absence: { userId: string; state: string }[] } }>(
      org.owner.authId,
      `select public.get_prosm_time_manager_dashboard(${cairoToday}, ${cairoToday}, 'org', null, 'Africa/Cairo') as d`,
    );
    expect(dash.rows![0].d.absence.find((entry) => entry.userId === employee.userId)?.state).toBe("leave");
  });

  it("works for past days and refreshes a draft timesheet", async () => {
    await t.su(
      `insert into timesheets (organization_id, user_id, period_start, period_end, status) values ($1, $2, ${cairoToday} - 10, ${cairoToday} - 1, 'draft')`,
      [org.id, employee.userId],
    );
    const result = await grant(org.owner, employee, `${cairoToday} - 5`, `${cairoToday} - 4`);
    expect(result.error).toBeNull();
    expect(result.rows![0].r.days).toBe(2);
    expect(result.rows![0].r).toMatchObject({ timesheetsUpdated: 1, timesheetsToReopen: 0 });
    const [sheet] = await t.su<{ total_leave_days: number }>("select total_leave_days from timesheets where user_id = $1", [employee.userId]);
    expect(Number(sheet.total_leave_days)).toBe(2);
  });

  it("refuses overlapping leave, oneself, and people outside the caller's sites", async () => {
    expect((await grant(manager, employee, cairoToday, cairoToday)).error).toMatch(/ALREADY HAS A PENDING OR APPROVED LEAVE/);
    expect((await grant(manager, manager, `${cairoToday} + 3`, `${cairoToday} + 3`)).error).toMatch(/YOURSELF/);
    expect((await grant(manager, outsider, `${cairoToday} + 3`, `${cairoToday} + 3`)).error).toMatch(/DO NOT MANAGE/);
    expect((await grant(employee, outsider, `${cairoToday} + 3`, `${cairoToday} + 3`)).error).toMatch(/NOT AUTHORIZED/);
  });
});
