// 2026-11-11 (owner): the allowance sheet takes lateness off like a real one - a price per late minute,
// resolved like the other prices, and a day's late amount comes off its total. Migration 20261111130000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg, createSite } from "./support/fixtures";

describe("late minute price on the allowances", () => {
  it("is saved and resolved like the other prices, and comes off the day's total", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Late Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    const saved = await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [site, JSON.stringify({ meal: 50, lateMinute: 2 })]);
    expect(saved.error).toBeNull();
    const [r] = await t.su<{ v: { lateMinute: string; meal: string } }>("select public.prosm_time_resolve_allowance_rates($1, $2) as v", [amira.userId, site]);
    expect(Number(r.v.lateMinute)).toBe(2);

    const [e] = await t.su<{ id: string }>(
      "insert into allowance_entries (organization_id, user_id, entry_date, meal_allowance, late_minutes, late_amount) values ($1, $2, '2027-02-01', 50, 15, 30) returning id",
      [org.id, amira.userId]);
    const [total] = await t.su<{ v: string }>("select public.prosm_time_entry_total(e) as v from allowance_entries e where id = $1", [e.id]);
    expect(Number(total.v)).toBe(20);

    // the day's facts carry the late minutes only when lateness is counted on the allowances
    const [f] = await t.su<{ v: { lateMinutes: number } }>("select public.prosm_time_allowance_day_facts($1, '2027-02-01') as v", [amira.userId]);
    expect(Number(f.v.lateMinutes)).toBe(0);
  });
});
