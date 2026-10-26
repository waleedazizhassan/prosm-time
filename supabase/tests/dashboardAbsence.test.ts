// v2.3.53 (owner 2026-10-26): the absent-today card counts everyone who has
// not clocked in and has no approved leave, and opens a sheet of who is
// absent and who is on leave. Migration 20261026120000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let present: TestMember;
let onLeave: TestMember;
let missing: TestMember;

type Absence = { userId: string; state: "absent" | "leave"; leaveType: string | null; leaveEnd: string | null; siteName: string | null; shiftStart: string | null };
type Dash = { kpi: { absentToday: number; onLeaveToday: number }; absence: Absence[] };

const cairoToday = "(now() at time zone 'Africa/Cairo')::date";
const dash = async () => {
  const result = await t.as<{ d: Dash }>(org.owner.authId, `select public.get_prosm_time_manager_dashboard(${cairoToday}, ${cairoToday}, 'org', null, 'Africa/Cairo') as d`);
  if (result.error) throw new Error(result.error);
  return result.rows![0].d;
};
const entry = (d: Dash, member: TestMember) => d.absence.find((row) => row.userId === member.userId);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Absence Co");
  site = await createSite(t, org, "Main");
  present = await addMember(t, org, "employee", "Here Today");
  onLeave = await addMember(t, org, "employee", "On Leave");
  missing = await addMember(t, org, "employee", "Not Here");
  for (const member of [present, onLeave, missing]) await assignToSite(t, site, member);
  expect((await clockIn(t, present, site)).error).toBeNull();
  await t.su(
    `insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status)
     values ($1, $2, 'annual', ${cairoToday}, ${cairoToday} + 2, 3, 'approved')`,
    [org.id, onLeave.userId],
  );
});

describe("absent today", () => {
  it("without schedules: no attendance and no approved leave is absent; leave is listed apart", async () => {
    const d = await dash();
    expect(entry(d, present)).toBeUndefined();
    expect(entry(d, missing)).toMatchObject({ state: "absent", siteName: "Main" });
    expect(entry(d, onLeave)).toMatchObject({ state: "leave", leaveType: "annual" });
    expect(d.kpi.absentToday).toBe(d.absence.filter((row) => row.state === "absent").length);
    expect(d.kpi.onLeaveToday).toBe(1);
  });

  it("with schedules: only the people with a shift today count as absent", async () => {
    await t.su(
      `insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, ${cairoToday}, '08:00', '16:00')`,
      [org.id, missing.userId, site],
    );
    const d = await dash();
    expect(d.absence.filter((row) => row.state === "absent").map((row) => row.userId)).toEqual([missing.userId]);
    expect(entry(d, missing)?.shiftStart).toBe("08:00");
    expect(d.kpi.absentToday).toBe(1);
  });

  it("nobody is absent on a public holiday", async () => {
    await t.su(`insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'Holiday', ${cairoToday}, ${cairoToday})`, [org.id]);
    const d = await dash();
    expect(d.kpi.absentToday).toBe(0);
    expect(entry(d, onLeave)?.state).toBe("leave");
  });
});
