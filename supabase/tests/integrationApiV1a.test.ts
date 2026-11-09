// 2026-11-09 integration API v1a (migration 20261109150000): shifts and leave balances to read;
// attendance received through the API - idempotent by the sender's id, pending until approved in
// the app, then one attendance record per clock-in/clock-out pair; overlaps stay pending.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let site: string;
let worker: TestMember;
let plain: TestMember;
type Result = { accepted: number; duplicates: number; rejected: number; results: { externalId: string; status: string; reason?: string; id?: string }[] };
const importEvents = async (events: unknown[]) => (await t.su<{ r: Result }>("select public.api_v1_attendance_import($1, null, $2) as r", [org.id, JSON.stringify(events)]))[0].r;
const sessions = async () => t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [worker.userId]);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Import Co");
  other = await createOrg(t, "Other Import");
  site = await createSite(t, org, "Gate");
  worker = await addMember(t, org, "employee", "Fingerprint Fady");
  plain = await addMember(t, org, "employee", "Plain Pam");
  await assignToSite(t, site, worker);
  await t.su("insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, current_date, '08:00', '16:00')", [org.id, worker.userId, site]);
});

describe("reading", () => {
  it("lists shifts of the window and leave balances of the organisation only", async () => {
    const shifts = (await t.su<{ r: { employeeId: string; startTime: string }[] }>("select public.api_v1_shifts($1, current_date - 1, current_date + 1, null, 50) as r", [org.id]))[0].r;
    expect(shifts).toEqual([expect.objectContaining({ employeeId: worker.userId, startTime: "08:00" })]);
    expect((await t.su<{ r: unknown[] }>("select public.api_v1_shifts($1, current_date - 1, current_date + 1, null, 50) as r", [other.id]))[0].r).toEqual([]);
    const balances = (await t.su<{ r: { employeeId: string; balances: { leaveType: string }[] }[] }>(
      "select public.api_v1_leave_balances($1, extract(year from current_date)::int, null, 50) as r", [org.id]))[0].r;
    expect(balances.map((b) => b.employeeId)).toContain(worker.userId);
    expect(balances.map((b) => b.employeeId)).not.toContain(org.owner.userId);
    expect(balances[0].balances.length).toBeGreaterThan(0);
  });
});

describe("receiving attendance", () => {
  let ids: string[] = [];
  const a = hoursAgo(9);
  const b = hoursAgo(1);

  it("accepts valid events once, says duplicate on resend, refuses bad ones and reused ids", async () => {
    const first = await importEvents([
      { externalId: "dev1-1001", employeeId: worker.userId, siteId: site, type: "clock_in", occurredAt: a, device: "Gate reader" },
      { externalId: "dev1-1002", employeeId: worker.userId, siteId: site, type: "clock_out", occurredAt: b },
      { externalId: "dev1-1003", employeeId: other.owner.userId, type: "clock_in", occurredAt: a },
      { externalId: "dev1-1004", employeeId: worker.userId, type: "lunch", occurredAt: a },
      { employeeId: worker.userId, type: "clock_in", occurredAt: a },
      { externalId: "dev1-1005", employeeId: worker.userId, type: "clock_in", occurredAt: new Date(Date.now() + 3600e3).toISOString() },
    ]);
    expect(first).toMatchObject({ accepted: 2, duplicates: 0, rejected: 4 });
    expect(first.results.map((r) => r.reason ?? r.status)).toEqual(["accepted", "accepted", "unknown_employee", "invalid_type", "external_id_required", "in_the_future"]);
    ids = first.results.filter((r) => r.status === "accepted").map((r) => r.id!);
    const again = await importEvents([{ externalId: "dev1-1001", employeeId: worker.userId, siteId: site, type: "clock_in", occurredAt: a }]);
    expect(again).toMatchObject({ accepted: 0, duplicates: 1 });
    const reused = await importEvents([{ externalId: "dev1-1001", employeeId: worker.userId, type: "clock_out", occurredAt: a }]);
    expect(reused.results[0]).toMatchObject({ status: "conflict" });
    expect(await importEvents([]).catch((error) => String(error))).toMatch(/1 TO 500/);
  });

  it("feeds nothing while pending", async () => {
    expect(await sessions()).toHaveLength(0);
  });

  it("is reviewed only by the owner or someone who may correct that person's attendance", async () => {
    expect((await t.as<{ r: unknown[] }>(plain.authId, "select public.list_prosm_time_imported_attendance() as r")).rows![0].r).toEqual([]);
    expect((await t.as(plain.authId, "select public.approve_prosm_time_imported_attendance($1)", [ids])).error).toMatch(/AUTHORITY/);
    const listed = await t.as<{ r: { externalId: string }[] }>(org.owner.authId, "select public.list_prosm_time_imported_attendance() as r");
    expect(listed.rows![0].r.map((r) => r.externalId).sort()).toEqual(["dev1-1001", "dev1-1002"]);
  });

  it("approving makes one attendance record from the pair, audited, with the imported time source", async () => {
    const result = await t.as<{ r: { applied: number; stillPending: number } }>(org.owner.authId, "select public.approve_prosm_time_imported_attendance($1) as r", [ids]);
    expect(result.error).toBeNull();
    expect(result.rows![0].r).toMatchObject({ applied: 1, stillPending: 0 });
    const [s] = await t.su<{ status: string; hours: number }>("select status, extract(epoch from (clock_out_at - clock_in_at)) / 3600 as hours from attendance_sessions where user_id = $1", [worker.userId]);
    expect(s.status).toBe("clocked_out");
    expect(Math.round(Number(s.hours))).toBe(8);
    expect(await t.su("select id from attendance_events where time_source = 'imported' and user_id = $1", [worker.userId])).toHaveLength(2);
    expect(await t.su("select id from audit_logs where action = 'attendance.import_approved'")).toHaveLength(1);
  });

  it("an event overlapping existing attendance stays pending with the reason; rejecting needs a reason", async () => {
    const overlap = await importEvents([
      { externalId: "dev1-2001", employeeId: worker.userId, type: "clock_in", occurredAt: hoursAgo(8) },
      { externalId: "dev1-2002", employeeId: worker.userId, type: "clock_out", occurredAt: hoursAgo(7) },
    ]);
    const pair = overlap.results.map((r) => r.id!);
    const result = await t.as<{ r: { applied: number; stillPending: number } }>(org.owner.authId, "select public.approve_prosm_time_imported_attendance($1) as r", [pair]);
    expect(result.rows![0].r).toMatchObject({ applied: 0, stillPending: 2 });
    const [row] = await t.su<{ status_reason: string }>("select status_reason from api_attendance_imports where id = $1", [pair[0]]);
    expect(row.status_reason).toBe("overlaps_existing_attendance");
    expect((await t.as(org.owner.authId, "select public.reject_prosm_time_imported_attendance($1, '')", [pair])).error).toMatch(/REASON/);
    expect((await t.as(org.owner.authId, "select public.reject_prosm_time_imported_attendance($1, 'duplicate reading')", [pair])).error).toBeNull();
  });
});
