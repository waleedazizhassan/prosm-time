// Governance verification on a real PostgreSQL (owner 2026-11-15), migration 20261115170000. The two-connection
// races themselves ran on a real PostgreSQL (PGlite is one connection); here the same rules are checked in turn:
// a decided correction or leave is not decided again on a stale screen, TRUNCATE never reaches attendance, a deleted
// attendance record leaves a trace in the audit trail, and a changed break time is kept.
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

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "EvidenceTwo");
  site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, site, employee);
  expect((await clockIn(t, employee, site)).error).toBeNull();
  expect((await clockOut(t, employee)).error).toBeNull();
  [{ id: shiftId }] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [employee.userId]);
});

describe("a decision is made once", () => {
  it("a correction already decided is not decided again", async () => {
    const submitted = await t.as<{ r: { correctionRequestId: string } }>(
      employee.authId, "select public.submit_prosm_time_correction_request($1, 'clock_in', now() - interval '3 hours', 'Forgot') as r", [shiftId],
    );
    expect(submitted.error).toBeNull();
    const requestId = submitted.rows![0].r.correctionRequestId;
    const decide = (action: string) =>
      t.as(org.owner.authId, `select public.review_prosm_time_exception('correction_request', $1, '${action}', 'x')`, [requestId]);
    expect((await decide("approved")).error).toBeNull();
    expect((await decide("rejected")).error).toMatch(/THIS REQUEST WAS ALREADY DECIDED/);
    const [row] = await t.su<{ status: string }>("select status from correction_requests where id = $1", [requestId]);
    expect(row.status).toBe("approved");
  });

  it("a leave decided by someone else is not decided again from a stale screen; the revoke screen still revokes", async () => {
    const [{ id: leaveId }] = await t.su<{ id: string }>(
      `insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status)
       values ($1, $2, 'annual', date_trunc('week', current_date + 42)::date, date_trunc('week', current_date + 42)::date, 1, 'pending') returning id`,
      [org.id, employee.userId],
    );
    const decide = (action: string, expected: string | null) =>
      t.as(org.owner.authId, `select public.review_prosm_time_leave($1, '${action}', 'x', null, $2)`, [leaveId, expected]);
    expect((await decide("approved", "pending")).error).toBeNull();
    // the second manager still sees it pending and rejects: refused, it stays approved
    expect((await decide("rejected", "pending")).error).toMatch(/THIS REQUEST WAS ALREADY DECIDED/);
    const status = async () => (await t.su<{ status: string }>("select status from leave_requests where id = $1", [leaveId]))[0].status;
    expect(await status()).toBe("approved");
    // revoking from the approved list (expects 'approved') works as before
    expect((await decide("rejected", "approved")).error).toBeNull();
    expect(await status()).toBe("rejected");
  });

  it("an older app that does not send what it saw behaves as before", async () => {
    const [{ id: leaveId }] = await t.su<{ id: string }>(
      `insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status)
       values ($1, $2, 'annual', date_trunc('week', current_date + 49)::date, date_trunc('week', current_date + 49)::date, 1, 'pending') returning id`,
      [org.id, employee.userId],
    );
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [leaveId])).error).toBeNull();
  });
});

describe("attendance cannot be wiped around its rules", () => {
  it("TRUNCATE is refused for the service role and for the table owner", async () => {
    for (const table of ["attendance_sessions", "attendance_events", "break_events"]) {
      expect(await asService(`truncate public.${table} cascade`)).toMatch(/permission denied|NOT TRUNCATED/);
      await expect(t.su(`truncate public.${table} cascade`)).rejects.toThrow(/ATTENDANCE IS EVIDENCE - IT IS NOT TRUNCATED/);
    }
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from attendance_sessions where id = $1", [shiftId]);
    expect(n).toBe(1);
  });

  it("a deleted attendance record leaves its id and day in the audit trail - no personal data", async () => {
    expect(await asService("delete from attendance_events where session_id = $1", [shiftId])).toBeNull();
    expect(await asService("delete from attendance_sessions where id = $1", [shiftId])).toBeNull();
    const rows = await t.su<{ entity_name: string; entity_id: string; subject_user_id: string; previous_state: Record<string, unknown> }>(
      "select entity_name, entity_id, subject_user_id, previous_state from audit_logs where action = 'ATTENDANCE_RECORD_DELETED' and organization_id = $1",
      [org.id],
    );
    const session = rows.find((row) => row.entity_name === "attendance_sessions")!;
    expect(session.entity_id).toBe(shiftId);
    expect(session.subject_user_id).toBe(employee.userId);
    expect(Object.keys(session.previous_state)).toEqual(["day"]);
    expect(rows.some((row) => row.entity_name === "attendance_events")).toBe(true);
  });

  it("a changed break time is kept in the revision log", async () => {
    expect((await clockIn(t, employee, site)).error).toBeNull();
    const [{ id: sessionId }] = await t.su<{ id: string }>(
      "select id from attendance_sessions where user_id = $1 and clock_out_at is null", [employee.userId],
    );
    const [{ id: breakId }] = await t.su<{ id: string }>(
      `insert into break_events (organization_id, attendance_session_id, user_id, paid, started_at, ended_at)
       values ($1, $2, $3, false, now() - interval '30 minutes', now() - interval '10 minutes') returning id`,
      [org.id, sessionId, employee.userId],
    );
    expect(await asService("update break_events set ended_at = now() - interval '5 minutes' where id = $1", [breakId])).toBeNull();
    const revisions = await t.su<{ field: string }>("select field from attendance_revisions where session_id = $1", [sessionId]);
    expect(revisions.map((row) => row.field)).toContain("break_ended_at");
  });
});
