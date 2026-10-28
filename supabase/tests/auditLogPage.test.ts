// v2.3.55 (owner 2026-10-28): the action log's own page - scoped like the
// dashboard's, filtered, paged; email deliveries are no actions. Migration 20261028100000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("action log page", () => {
  it("the Owner reads the actions, not the email deliveries; filters and pages work; an employee may not", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Log Co");
    const worker = await addMember(t, org, "employee", "Walid");
    const log = (action: string, minutesAgo: number) =>
      t.su("insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description, created_at) values ($1, $2, $3, $4, 'x', 'y', now() - make_interval(mins => $5))", [
        org.id,
        org.owner.userId,
        worker.userId,
        action,
        minutesAgo,
      ]);
    await log("ADMIN_CLOCK_IN_ON_BEHALF", 3);
    await log("EMAIL_SENT", 2);
    await log("leave.deduction_set", 1);
    const read = async (args = "null, null, null, null, null, 50") =>
      (await t.as<{ l: { action: string; created_at: string }[] }>(org.owner.authId, `select public.list_prosm_time_audit_log(${args}) as l`)).rows![0].l.map((row) => row.action);

    const all = await read();
    expect(all).toContain("ADMIN_CLOCK_IN_ON_BEHALF");
    expect(all).toContain("leave.deduction_set");
    expect(all).not.toContain("EMAIL_SENT");
    expect(await read("null, null, null, '^leave[.]', null, 50")).toEqual(["leave.deduction_set"]);
    // pages: the second starts after the first's last row, with no overlap
    const page = async (before: string | null) =>
      (await t.as<{ l: { id: string; created_at: string }[] }>(org.owner.authId, "select public.list_prosm_time_audit_log(null, null, null, null, $1, 2) as l", [before])).rows![0].l;
    const one = await page(null);
    const two = await page(one[one.length - 1].created_at);
    expect(one).toHaveLength(2);
    expect(two.some((row) => one.some((seen) => seen.id === row.id))).toBe(false);
    expect(two.every((row) => row.created_at < one[one.length - 1].created_at)).toBe(true);

    expect((await t.as(worker.authId, "select public.list_prosm_time_audit_log()")).error).toMatch(/AUDIT.VIEW/);
  });
});
