// Owner 2026-10-21: an employee produces their own timesheet; not someone
// else's. Migration 20261021120000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("own timesheet", () => {
  it("lets an employee generate their own timesheet, never a coworker's", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Nile");
    const siteId = await createSite(t, org, "Capital");
    const employee = await addMember(t, org, "employee", "Hana");
    const coworker = await addMember(t, org, "employee", "Omar");
    await assignToSite(t, siteId, employee);
    await assignToSite(t, siteId, coworker);
    const generate = (userId: string) =>
      t.as(employee.authId, "select public.generate_prosm_time_timesheet($1, date_trunc('month', current_date)::date, current_date)", [userId]);
    expect((await generate(employee.userId)).error).toBeNull();
    expect((await generate(coworker.userId)).error).toMatch(/NOT AUTHORIZED/);
  });
});
