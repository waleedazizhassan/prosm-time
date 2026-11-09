// 2026-11-09 (owner): labour cost is about external labour - each worker with their contractor,
// pay and unit, days and hours from the kiosk, and the amount for the period. Employees are not in
// it (they have their payroll). Migration 20261109280000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

const read = "select * from public.list_prosm_time_report_labor_cost('2026-10-01', '2026-10-31')";
type Row = { worker_name: string; contractor_name: string | null; rate_unit: string | null; days: number; hours: string; amount: string | null };

describe("labour cost (external labour)", () => {
  it("prices each worker by their unit, shows the contractor, leaves out employees and the unpriced amount empty", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Cost Co");
    const site = await createSite(t, org, "Yard");
    const staff = await addMember(t, org, "employee", "Staff");
    await assignToSite(t, site, staff);
    await t.su(
      `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
       values ($1, $2, $3, 'clocked_out', '2026-10-05 08:00+00', '2026-10-05 12:00+00')`,
      [org.id, staff.userId, site],
    );
    const worker = async (name: string, contractor: string | null) =>
      (await t.as<{ r: { workerId: string } }>(org.owner.authId, "select public.create_prosm_time_external_worker($1, $2) as r", [name, contractor])).rows![0].r.workerId;
    const daily = await worker("Daily Worker", "Nile Contracting");
    const hourly = await worker("Hourly Worker", "Nile Contracting");
    const unpriced = await worker("Unpriced Worker", null);
    await t.as(org.owner.authId, "select public.set_prosm_time_external_rate($1, 300, 'EGP', 'DAILY', '2026-01-01')", [daily]);
    await t.as(org.owner.authId, "select public.set_prosm_time_external_rate($1, 50, 'EGP', 'HOURLY', '2026-01-01')", [hourly]);
    for (const [id, days] of [[daily, ["2026-10-06", "2026-10-07"]], [hourly, ["2026-10-06"]], [unpriced, ["2026-10-06"]]] as const) {
      for (const day of days) {
        await t.su(
          `insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_at, clock_out_at, clock_in_latitude, clock_in_longitude)
           values ($1, $2, $3, $4::date + time '08:00', $4::date + time '14:00', 30, 31)`,
          [org.id, id, site, day],
        );
      }
    }

    const { rows, error } = await t.as<Row>(org.owner.authId, read);
    expect(error).toBeNull();
    const by = new Map(rows!.map((r) => [r.worker_name, r]));
    expect(by.has("Staff")).toBe(false);
    expect(by.get("Daily Worker")).toMatchObject({ contractor_name: "Nile Contracting", rate_unit: "DAILY", days: 2 });
    expect(Number(by.get("Daily Worker")!.amount)).toBe(600);
    expect(Number(by.get("Hourly Worker")!.hours)).toBe(6);
    expect(Number(by.get("Hourly Worker")!.amount)).toBe(300);
    expect(by.get("Unpriced Worker")!.amount).toBeNull();

    expect((await t.as(staff.authId, read)).error).toMatch(/EXTERNAL LABOUR PAY AUTHORITY/);
  });
});
