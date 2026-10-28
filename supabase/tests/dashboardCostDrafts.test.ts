// v2.3.59 (owner 2026-10-28: "this zero is not real"): the dashboard's cost
// estimate counts allowance entries still in draft; only rejected ones are
// left out. Migration 20261028150000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("dashboard allowances and cost", () => {
  it("counts draft, submitted and approved entries, not rejected ones", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Cost Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const entry = (status: string, meal: number, overtimeMinutes: number, overtimeAmount: number) =>
      t.su(
        `insert into allowance_entries (organization_id, user_id, entry_date, meal_allowance, overtime_minutes, overtime_amount, status)
         values ($1, $2, current_date - $3::int, $4, $5, $6, $7)`,
        [org.id, worker.userId, ["draft", "submitted", "approved", "rejected"].indexOf(status), meal, overtimeMinutes, overtimeAmount, status],
      );
    await entry("draft", 10, 5, 6);
    await entry("submitted", 20, 0, 0);
    await entry("approved", 30, 60, 50);
    await entry("rejected", 1000, 600, 900);

    const result = await t.as<{ d: { allowances: { total: number; overtimeAmount: number; overtimeMinutes: number } } }>(
      org.owner.authId,
      "select public.get_prosm_time_manager_dashboard(current_date - 7, current_date, 'org', null, 'Africa/Cairo') as d",
    );
    expect(result.error).toBeNull();
    const allowances = result.rows![0].d.allowances;
    expect(Number(allowances.overtimeAmount)).toBe(56);
    expect(Number(allowances.overtimeMinutes)).toBe(65);
    expect(Number(allowances.total)).toBeGreaterThanOrEqual(60);
    expect(Number(allowances.total)).toBeLessThan(1000);
  });
});
