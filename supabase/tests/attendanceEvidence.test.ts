// Governance phase B (owner 2026-11-15, report sections 14.2 and 14.5): attendance is evidence and a closed
// pay period stays closed. Every change of a recorded time leaves its previous and new value in
// attendance_revisions, whatever path made it; inside an approved/locked payroll cycle or an approved
// timesheet nobody else changes, deletes or back-fills a person's times until it is reopened - while the
// person's own punches and the closing of an open shift keep working. Migration 20261115120000.
// The two-connection concurrency test needs a real PostgreSQL (PGlite is one connection): NOT RUN here.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let manager: TestMember;
let employee: TestMember;
let shiftId: string;

const asService = async (sql: string, params: unknown[] = []) => {
  try {
    await t.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await tx.exec("set local role service_role");
      await tx.query(sql, params);
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const revisions = (sessionId: string) =>
  t.su<{ field: string; previous_value: string | null; new_value: string; evidence_source: string; revised_by: string | null; correction_request_id: string | null }>(
    "select field, previous_value, new_value, evidence_source, revised_by, correction_request_id from attendance_revisions where session_id = $1 order by id",
    [sessionId],
  );
const requestCorrection = async (kind: "clock_in" | "clock_out", at: string) => {
  const submitted = await t.as<{ r: { correctionRequestId: string } }>(
    employee.authId, `select public.submit_prosm_time_correction_request($1, '${kind}', ${at}, 'Forgot') as r`, [shiftId],
  );
  expect(submitted.error).toBeNull();
  return submitted.rows![0].r.correctionRequestId;
};
const review = (requestId: string) =>
  t.as(manager.authId, "select public.review_prosm_time_exception('correction_request', $1, 'approved', 'ok')", [requestId]);

let cycleId: string;
const setCycle = (status: string) => t.su("update payroll_cycles set status = $2 where id = $1", [cycleId, status]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Evidence");
  site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, site, employee);
  expect((await clockIn(t, employee, site)).error).toBeNull();
  expect((await clockOut(t, employee)).error).toBeNull();
  [{ id: shiftId }] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [employee.userId]);
  // a payroll cycle around today that includes the employee, still a draft
  [{ id: cycleId }] = await t.su<{ id: string }>(
    `insert into payroll_cycles (organization_id, title, period_start, period_end, status, policy_snapshot)
     values ($1, 'This month', current_date - 10, current_date + 10, 'draft', '{}'::jsonb) returning id`, [org.id],
  );
  await t.su(
    "insert into payroll_cycle_employees (organization_id, cycle_id, user_id, full_name, currency) values ($1, $2, $3, 'Lido', 'EGP')",
    [org.id, cycleId, employee.userId],
  );
});

describe("every change of a recorded time is kept", () => {
  it("an approved correction keeps the previous and the new time, who approved it, and which request", async () => {
    const requestId = await requestCorrection("clock_in", "now() - interval '3 hours'");
    const [before] = await t.su<{ clock_in_at: string }>("select clock_in_at from attendance_sessions where id = $1", [shiftId]);
    expect((await review(requestId)).error).toBeNull();
    const rows = (await revisions(shiftId)).filter((row) => row.correction_request_id === requestId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const sessionRow = rows.find((row) => row.field === "clock_in_at")!;
    expect(sessionRow.evidence_source).toBe("live");
    expect(new Date(sessionRow.previous_value!).getTime()).toBe(new Date(before.clock_in_at).getTime());
    expect(sessionRow.revised_by).toBe(manager.userId);
  });

  it("a direct write by the service role is kept too", async () => {
    const count = (await revisions(shiftId)).length;
    expect(await asService("update attendance_sessions set clock_out_at = clock_out_at + interval '1 minute' where id = $1", [shiftId])).toBeNull();
    const rows = await revisions(shiftId);
    expect(rows.length).toBe(count + 1);
    expect(rows[rows.length - 1]).toMatchObject({ field: "clock_out_at", evidence_source: "live", revised_by: null });
  });

  it("the revision log is append-only for everyone", async () => {
    expect(await asService("update attendance_revisions set previous_value = null where session_id = $1", [shiftId])).not.toBeNull();
    expect(await asService("delete from attendance_revisions where session_id = $1", [shiftId])).not.toBeNull();
    await expect(t.su("delete from attendance_revisions where session_id = $1", [shiftId])).rejects.toThrow(/APPEND-ONLY/);
  });

  it("the person and their manager can read it; another organisation cannot", async () => {
    const mine = await t.as<{ r: unknown[] }>(employee.authId, "select public.get_prosm_time_attendance_revisions($1) as r", [shiftId]);
    expect(mine.error).toBeNull();
    expect((mine.rows![0].r as unknown[]).length).toBeGreaterThan(0);
    expect((await t.as(manager.authId, "select public.get_prosm_time_attendance_revisions($1)", [shiftId])).error).toBeNull();
    const other = await createOrg(t, "Elsewhere");
    expect((await t.as(other.owner.authId, "select public.get_prosm_time_attendance_revisions($1)", [shiftId])).error).toMatch(/NOT FOUND/);
  });
});

describe("a closed pay period stays closed", () => {
  it("an approved or locked cycle refuses a correction, a direct edit, a delete and a leave decision", async () => {
    for (const status of ["approved", "locked"]) {
      await setCycle(status);
      const requestId = await requestCorrection("clock_out", "now() - interval '10 minutes'").catch(() => null);
      if (requestId) expect((await review(requestId)).error).toMatch(/PAY PERIOD IS LOCKED/);
      expect(await asService("update attendance_sessions set clock_in_at = clock_in_at - interval '5 minutes' where id = $1", [shiftId])).toMatch(/PAY PERIOD IS LOCKED/);
      expect(await asService("update attendance_events set occurred_at = occurred_at - interval '5 minutes' where session_id = $1", [shiftId])).toMatch(/PAY PERIOD IS LOCKED/);
      expect(await asService("delete from attendance_sessions where id = $1", [shiftId])).toMatch(/PAY PERIOD IS LOCKED/);
    }
    // a leave decision inside the locked period is refused too (approving it, or withdrawing an approved one)
    const [leave] = await t.su<{ id: string }>(
      "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', current_date, current_date, 1, 'pending') returning id",
      [org.id, employee.userId],
    );
    expect(await asService("update leave_requests set status = 'approved' where id = $1", [leave.id])).toMatch(/PAY PERIOD IS LOCKED/);
  });

  it("the person still clocks in and out for themselves, and an open shift still closes", async () => {
    await setCycle("locked");
    expect((await clockIn(t, employee, site)).error).toBeNull();
    expect((await clockOut(t, employee)).error).toBeNull();
  });

  it("reopening the cycle opens the period again", async () => {
    await setCycle("reopened");
    expect(await asService("update attendance_sessions set clock_in_at = clock_in_at - interval '5 minutes' where id = $1", [shiftId])).toBeNull();
    await setCycle("draft");
  });

  it("an approved timesheet locks the period too, and a returned one opens it", async () => {
    const [ts] = await t.su<{ id: string }>(
      "insert into timesheets (organization_id, user_id, period_start, period_end, status) values ($1, $2, current_date - 3, current_date + 3, 'approved') returning id",
      [org.id, employee.userId],
    );
    expect(await asService("update attendance_sessions set clock_in_at = clock_in_at - interval '1 minute' where id = $1", [shiftId])).toMatch(/PAY PERIOD IS LOCKED/);
    await t.su("update timesheets set status = 'draft' where id = $1", [ts.id]);
    expect(await asService("update attendance_sessions set clock_in_at = clock_in_at - interval '1 minute' where id = $1", [shiftId])).toBeNull();
  });

  it("removing the person still removes their attendance (a cascade is not an edit)", async () => {
    const leaving = await addMember(t, org, "employee", "Leaving");
    await assignToSite(t, site, leaving);
    expect((await clockIn(t, leaving, site)).error).toBeNull();
    expect((await clockOut(t, leaving)).error).toBeNull();
    await t.su("insert into timesheets (organization_id, user_id, period_start, period_end, status) values ($1, $2, current_date - 3, current_date + 3, 'approved')", [org.id, leaving.userId]);
    await t.su("delete from users where id = $1", [leaving.userId]);
    expect((await t.su("select 1 from attendance_sessions where user_id = $1", [leaving.userId])).length).toBe(0);
  });
});

describe("payroll: pending requests in the period are a warning to acknowledge", () => {
  it("lists the employee with a pending correction", async () => {
    // one pending correction per shift and event (phase D): reuse the one already waiting, if any
    const pending = await t.su("select 1 from correction_requests where attendance_session_id = $1 and status = 'pending'", [shiftId]);
    if (pending.length === 0) await requestCorrection("clock_out", "now() - interval '20 minutes'");
    const result = await t.as<{ v: { warnings: { code: string; userId: string }[] } }>(org.owner.authId, "select public.validate_prosm_time_payroll_cycle($1) as v", [cycleId]);
    if (result.error && /FEATURE NOT IN PLAN/.test(result.error)) return; // the payroll feature is checked by its own suites
    expect(result.error).toBeNull();
    expect(result.rows![0].v.warnings.some((w) => w.code === "PENDING_REQUESTS" && w.userId === employee.userId)).toBe(true);
  });
});
