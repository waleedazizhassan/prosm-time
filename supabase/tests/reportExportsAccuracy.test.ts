// v2.3.43 step 18 (item 16): the exported reports reflect the earlier steps -
// absences only on working days (holidays and rest days are not absences)
// and by the site's own day; a long session closed automatically shows as
// waiting for review; the manager-actions report carries the new privileged
// changes, for the people the reader sees. Migration 20261025250000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let otherSite: string;
let manager: TestMember;
let worker: TestMember;
let elsewhere: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Reports Co");
  site = await createSite(t, org, "Main");
  otherSite = await createSite(t, org, "Other");
  manager = await addMember(t, org, "manager", "Main Manager");
  worker = await addMember(t, org, "employee", "Main Worker");
  elsewhere = await addMember(t, org, "employee", "Other Worker");
  await assignToSite(t, site, worker);
  await assignToSite(t, otherSite, elsewhere);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);

  const [{ id: template }] = await t.su<{ id: string }>(
    "insert into shift_templates (organization_id, site_id, name, start_time, end_time) values ($1, $2, 'Day', '08:00', '16:00') returning id",
    [org.id, site],
  );
  // Mon 2 Nov (workday), Tue 3 Nov (worked just after midnight Cairo time), Wed 4 Nov (holiday), Fri 6 Nov (weekly rest).
  for (const day of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-06"]) {
    await t.su(
      "insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time) values ($1, $2, $3, $4, $5, '08:00', '16:00')",
      [org.id, worker.userId, site, template, day],
    );
  }
  await t.su("insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'Holiday', '2026-11-04', '2026-11-04')", [org.id]);
  // 00:30 on 3 Nov in Cairo is 22:30 on 2 Nov in UTC.
  await t.su(
    "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', '2026-11-02T22:30:00Z', '2026-11-03T06:00:00Z')",
    [org.id, worker.userId, site],
  );
  // A 14-hour session closed automatically, waiting for review.
  await t.su(
    "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at, auto_closed, auto_closed_at, hours_review_status) values ($1, $2, $3, 'clocked_out', '2026-10-31T06:00:00Z', '2026-10-31T20:00:00Z', true, '2026-10-31T20:00:00Z', 'pending')",
    [org.id, worker.userId, site],
  );
  for (const subject of [worker, elsewhere]) {
    await t.su(
      "insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description, reason, created_at) values ($1, $2, $3, 'allowances.edit_during_review', 'allowance_entries', 'edited', 'wrong transport', '2026-11-02T10:00:00Z')",
      [org.id, org.owner.userId, subject.userId],
    );
  }
});

describe("report exports accuracy", () => {
  it("an absence is only a working day, counted by the site's day", async () => {
    const result = await t.as<{ shift_date: string }>(org.owner.authId, "select shift_date::text from public.list_prosm_time_report_absences('2026-11-01', '2026-11-07')");
    expect(result.error).toBeNull();
    expect(result.rows!.map((row) => row.shift_date)).toEqual(["2026-11-02"]);
  });

  it("a long session closed automatically shows as waiting for review", async () => {
    const result = await t.as<{ review_state: string; still_open: boolean }>(manager.authId, "select review_state, still_open from public.list_prosm_time_report_missing_checkouts('2026-10-31', '2026-10-31')");
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ review_state: "pending_review", still_open: false }]);
  });

  it("the manager-actions report carries allowance edits, only for the people the reader sees", async () => {
    const forManager = await t.as<{ subject_name: string; action: string }>(manager.authId, "select subject_name, action from public.list_prosm_time_report_manager_overrides('2026-11-01', '2026-11-07')");
    expect(forManager.error).toBeNull();
    expect(forManager.rows).toEqual([{ subject_name: "Main Worker", action: "allowances.edit_during_review" }]);
    const forOwner = await t.as<{ subject_name: string }>(org.owner.authId, "select subject_name from public.list_prosm_time_report_manager_overrides('2026-11-01', '2026-11-07')");
    expect(forOwner.rows!.map((row) => row.subject_name).sort()).toEqual(["Main Worker", "Other Worker"]);
  });
});
