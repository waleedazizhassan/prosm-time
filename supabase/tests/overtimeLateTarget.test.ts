// 2026-11-10 (owner): lateness and overtime go to the salary, to the allowances, or nowhere - the
// owner's choice, limited by the plan. Migration 20261110210000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("where lateness and overtime are counted", () => {
  it("defaults to the allowances, can be changed by the owner only, and only to what the plan has", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Target Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const get = async () => (await t.as<{ v: string }>(org.owner.authId, "select public.get_prosm_time_overtime_late_target() as v")).rows![0].v;
    const set = (authId: string, v: string) => t.as(authId, "select public.set_prosm_time_overtime_late_target($1)", [v]);

    expect(await get()).toBe("allowances");
    expect((await set(org.owner.authId, "payroll")).error).toBeNull();
    expect(await get()).toBe("payroll");
    expect((await set(org.owner.authId, "none")).error).toBeNull();
    expect(await get()).toBe("none");
    expect((await set(amira.authId, "payroll")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
    expect((await set(org.owner.authId, "bonus")).error).toMatch(/INVALID CHOICE/);
  });
});
