// v2.3.43 step 6 (item 23): management controls overtime, deductions and
// permissions - late permission without deduction, "no overtime" permission,
// overtime approval, multipliers per kind of day, break rules, manual day
// adjustment, refusals, and nothing after approval. Migration 20261025150000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;
let manager: TestMember;
let supervisor: TestMember;

async function shift(date: string, from: string, to: string) {
  const [endDay, endTime] = to.startsWith("+1 ") ? [`(date '${date}' + 1)::text`, to.slice(3)] : [`'${date}'`, to];
  await t.su(
    `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
     values ($1, $2, $3, 'clocked_out', ($4 || ' ' || $5)::timestamp at time zone 'Africa/Cairo', (${endDay} || ' ' || $6)::timestamp at time zone 'Africa/Cairo')`,
    [org.id, worker.userId, site, date, from, endTime],
  );
}

const summary = async (date: string) =>
  (await t.su<{ s: Record<string, number | string | boolean> }>("select public.prosm_time_day_summary($1, $2) as s", [worker.userId, date]))[0].s;

async function entry(date: string) {
  expect((await t.as(worker.authId, "select public.upsert_prosm_time_allowance_entry($1)", [date])).error).toBeNull();
  const [row] = await t.su<{ overtime_amount: string; overtime_minutes: string }>(
    "select overtime_amount, overtime_minutes from allowance_entries where user_id = $1 and entry_date = $2",
    [worker.userId, date],
  );
  return { amount: Number(row.overtime_amount), minutes: Number(row.overtime_minutes) };
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Minya");
  site = await createSite(t, org, "Mill");
  worker = await addMember(t, org, "employee", "Hany Saad");
  manager = await addMember(t, org, "manager", "Mill Manager");
  supervisor = await addMember(t, org, "supervisor", "Mill Supervisor");
  for (const member of [worker, supervisor]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("update sites set timezone = 'Africa/Cairo', overtime_start_time = '17:00', late_deduction_start_time = '08:15' where id = $1", [site]);
  await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [site, JSON.stringify({ overtimeHour: 100 })]);
});

describe("overtime, deductions and permissions (item 23)", () => {
  it("by default overtime waits for a manager's approval and counts for nothing until then", async () => {
    await shift("2026-10-25", "08:00", "18:00");
    const s = await summary("2026-10-25");
    expect(s.approvalMode).toBe("approval");
    expect(Number(s.overtimeMinutes)).toBe(0);
    expect(Number(s.overtimePendingApprovalMinutes)).toBeCloseTo(60, 6);
    expect((await entry("2026-10-25")).amount).toBe(0);
    const queue = await t.as<{ q: { overtime: unknown[] } }>(manager.authId, "select public.list_prosm_time_permission_queue() as q");
    expect(queue.rows?.[0].q.overtime).toHaveLength(1);
  });

  it("the site's manager approves the day's overtime (audited); a supervisor cannot", async () => {
    expect((await t.as(supervisor.authId, "select public.adjust_prosm_time_attendance_day($1, '2026-10-25', null, null, null, true, 'ok')", [worker.userId])).error).toMatch(/MANAGE_PERMISSIONS/);
    expect((await t.as(manager.authId, "select public.adjust_prosm_time_attendance_day($1, '2026-10-25', null, null, null, true, 'stock count')", [worker.userId])).error).toBeNull();
    expect(Number((await summary("2026-10-25")).overtimeMinutes)).toBeCloseTo(60, 6);
    expect((await entry("2026-10-25")).amount).toBe(100);
    expect(await t.su("select id from audit_logs where action = 'attendance.overtime_approved'")).toHaveLength(1);
  });

  it("a late-arrival permission (paid) removes the lateness and its deduction", async () => {
    await shift("2026-10-26", "09:15", "16:00");
    expect(Number((await summary("2026-10-26")).lateMinutes)).toBeCloseTo(60, 6);
    expect((await t.as(worker.authId, "select public.request_prosm_time_attendance_permission('2026-10-01', 'late_arrival', 60, 'doctor')")).error).toMatch(/BEFORE THE DAY/);
    expect(
      (await t.as(manager.authId, "select public.grant_prosm_time_attendance_permission($1, '2026-10-26', 'late_arrival', 60, true, null, null, 'doctor appointment')", [worker.userId])).error,
    ).toBeNull();
    const s = await summary("2026-10-26");
    expect(Number(s.lateMinutes)).toBe(0);
    expect(Number(s.deductionMinutes)).toBe(0);
  });

  it("a partial deduction (50%) halves the late minutes", async () => {
    await shift("2026-10-27", "08:45", "16:00");
    await t.as(manager.authId, "select public.grant_prosm_time_attendance_permission($1, '2026-10-27', 'late_arrival', null, false, 50, null, 'traffic')", [worker.userId]);
    expect(Number((await summary("2026-10-27")).deductionMinutes)).toBeCloseTo(15, 6);
  });

  it("a 'no overtime' permission stops the extra time from counting, even when overtime is automatic", async () => {
    await t.su("insert into overtime_policies (organization_id, approval_mode) values ($1, 'automatic')", [org.id]);
    await shift("2026-10-28", "08:00", "19:00");
    expect(Number((await summary("2026-10-28")).overtimeMinutes)).toBeCloseTo(120, 6);
    await t.as(manager.authId, "select public.grant_prosm_time_attendance_permission($1, '2026-10-28', 'no_overtime', null, true, null, null, 'stayed for personal reasons')", [worker.userId]);
    expect(Number((await summary("2026-10-28")).overtimeMinutes)).toBe(0);
  });

  it("the Owner's multipliers: rest day x2, night x1.5 (22:00-06:00); 1.0 is today's behaviour", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_overtime_policy(null, null, '{\"approvalMode\":\"automatic\"}'::jsonb)")).error).toMatch(/ONLY THE OWNER/);
    expect(
      (await t.as(org.owner.authId, "select public.set_prosm_time_overtime_policy(null, null, $1::jsonb)", [
        JSON.stringify({ approvalMode: "automatic", multiplierNormal: 1, multiplierNight: 1.5, multiplierWeeklyRest: 2, multiplierPublicHoliday: 2 }),
      ])).error,
    ).toBeNull();
    await shift("2026-10-30", "10:00", "12:00"); // Friday, 2 h
    expect((await entry("2026-10-30")).amount).toBe(400);
    // (not 29 October: Egypt leaves summer time that night)
    await shift("2026-11-03", "08:00", "23:00"); // 6 h overtime, 1 h of it at night
    const s = await summary("2026-11-03");
    expect(Number(s.overtimeMinutes)).toBeCloseTo(360, 6);
    expect(Number(s.nightOvertimeMinutes)).toBeCloseTo(60, 6);
    expect((await entry("2026-11-03")).amount).toBe(650);
  });

  it("an employee asks in advance; the manager approves it as paid", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const asked = await t.as<{ r: { id: string } }>(worker.authId, "select public.request_prosm_time_attendance_permission($1, 'early_leave', 60, 'family matter') as r", [tomorrow]);
    expect(asked.error).toBeNull();
    const id = asked.rows?.[0].r.id;
    expect((await t.as(worker.authId, "select public.review_prosm_time_attendance_permission($1, 'approved')", [id])).error).toMatch(/MANAGE_PERMISSIONS/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_attendance_permission($1, 'approved', true)", [id])).error).toBeNull();
    const [{ status }] = await t.su<{ status: string }>("select status from attendance_permissions where id = $1", [id]);
    expect(status).toBe("approved");
  });

  it("unpaid breaks come off the worked time; no break on a template with an automatic deduction takes it", async () => {
    const [{ id: template }] = await t.su<{ id: string }>(
      "insert into shift_templates (organization_id, site_id, name, start_time, end_time) values ($1, $2, 'Day', '08:00', '16:00') returning id",
      [org.id, site],
    );
    expect((await t.as(manager.authId, "select public.set_prosm_time_shift_break_rules($1, true, null, 30)", [template])).error).toBeNull();
    await t.su(
      "insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time) values ($1, $2, $3, $4, '2026-11-02', '08:00', '16:00')",
      [org.id, worker.userId, site, template],
    );
    await shift("2026-11-02", "08:00", "16:00");
    const s = await summary("2026-11-02");
    expect(Number(s.workedMinutes)).toBeCloseTo(450, 6);
  });

  it("a manual adjustment needs a reason, and nothing changes once the period is approved", async () => {
    expect((await t.as(manager.authId, "select public.adjust_prosm_time_attendance_day($1, '2026-10-27', null, null, 0, null, '')", [worker.userId])).error).toMatch(/REASON/);
    await t.su("update allowance_entries set status = 'approved' where user_id = $1 and entry_date = '2026-10-25'", [worker.userId]);
    expect((await t.as(manager.authId, "select public.adjust_prosm_time_attendance_day($1, '2026-10-25', 0, null, null, null, 'late fix')", [worker.userId])).error).toMatch(/ALREADY APPROVED/);
    expect((await t.as(manager.authId, "select public.grant_prosm_time_attendance_permission($1, '2026-10-25', 'no_overtime', null, true, null, null, 'x')", [worker.userId])).error).toMatch(/ALREADY APPROVED/);
  });
});
