// 2026-11-02 (plan stage 8.5): hours by the rate in force, hidden from those without
// the pay permission. Migration 20261102130000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

const read = "select * from public.list_prosm_time_report_labor_cost('2026-10-01', '2026-10-31')";

describe("labour cost", () => {
  it("prices hours by the rate and leaves the cost empty without one", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Cost Co");
    const site = await createSite(t, org, "Yard");
    const paid = await addMember(t, org, "employee", "Paid");
    const unpriced = await addMember(t, org, "employee", "Unpriced");
    for (const member of [paid, unpriced]) {
      await assignToSite(t, site, member);
      await t.su(
        `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
         values ($1, $2, $3, 'clocked_out', '2026-10-05 08:00+00', '2026-10-05 12:00+00')`,
        [org.id, member.userId, site],
      );
    }
    await t.su("insert into worker_pay_rates (organization_id, user_id, rate_type, rate_amount, currency, effective_from) values ($1, $2, 'MONTHLY', 2400, 'EGP', '2026-01-01')", [org.id, paid.userId]);

    const { rows, error } = await t.as<{ user_full_name: string; hours: string; cost: string | null }>(org.owner.authId, read);
    expect(error).toBeNull();
    const byName = new Map(rows!.map((row) => [row.user_full_name, row]));
    expect(Number(byName.get("Paid")!.hours)).toBe(4);
    expect(Number(byName.get("Paid")!.cost)).toBe(40);
    expect(byName.get("Unpriced")!.cost).toBeNull();

    expect((await t.as(paid.authId, read)).error).toMatch(/PAYROLL AUTHORITY REQUIRED/);
  });
});
