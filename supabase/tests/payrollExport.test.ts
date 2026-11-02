// 2026-11-02 (plan stage 8.1): the accountant's period summary and its templates.
// Migration 20261102100000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

const read = "select * from public.list_prosm_time_report_payroll('2026-10-01', '2026-10-31')";

describe("payroll export", () => {
  it("adds up approved money only, and shows no one outside the organisation", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Pay Co");
    const other = await createOrg(t, "Other Pay Co");
    const worker = await addMember(t, org, "employee", "Worker");
    await addMember(t, other, "employee", "Stranger");
    const entry = "insert into allowance_entries (organization_id, user_id, entry_date, meal_allowance, overtime_amount, status) values ($1, $2, $3, 100, 50, $4)";
    await t.su(entry, [org.id, worker.userId, "2026-10-05", "approved"]);
    await t.su(entry, [org.id, worker.userId, "2026-10-06", "submitted"]);
    await t.su("insert into payroll_adjustments (organization_id, user_id, kind, work_date, amount, currency, source_type, source_id) values ($1, $2, 'unpaid_leave_deduction', '2026-10-07', -40, 'EGP', 'leave_requests', gen_random_uuid())", [org.id, worker.userId]);

    const { rows, error } = await t.as<{ full_name: string; allowances: string; overtime_amount: string; leave_deduction: string }>(org.owner.authId, read);
    expect(error).toBeNull();
    expect(rows!.map((row) => row.full_name)).toEqual(["Worker"]);
    expect(Number(rows![0].allowances)).toBe(100);
    expect(Number(rows![0].overtime_amount)).toBe(50);
    expect(Number(rows![0].leave_deduction)).toBe(40);
  });

  it("is refused without the pay permission, and over a long period", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Gate Co");
    const worker = await addMember(t, org, "employee", "Worker");
    expect((await t.as(worker.authId, read)).error).toMatch(/PAYROLL AUTHORITY REQUIRED/);
    expect((await t.as(org.owner.authId, "select * from public.list_prosm_time_report_payroll('2026-01-01', '2026-12-31')")).error).toMatch(/PERIOD TOO LONG/);
  });

  it("templates stay inside the organisation", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Tpl Co");
    const other = await createOrg(t, "Other Tpl Co");
    const worker = await addMember(t, org, "employee", "Worker");
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_payroll_template('Bank', array['name','workedHours'])")).error).toBeNull();
    expect((await t.as(org.owner.authId, "select * from public.list_prosm_time_payroll_templates()")).rows).toHaveLength(1);
    expect((await t.as(other.owner.authId, "select * from public.list_prosm_time_payroll_templates()")).rows).toHaveLength(0);
    expect((await t.as(worker.authId, "select public.save_prosm_time_payroll_template('Mine', array['name'])")).error).toMatch(/PAYROLL AUTHORITY REQUIRED/);
    expect((await t.as(org.owner.authId, "select * from payroll_export_templates")).error).not.toBeNull();
  });
});
