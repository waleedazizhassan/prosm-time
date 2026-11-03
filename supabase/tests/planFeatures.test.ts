// 2026-11-03 (owner, the plans sheet): a plan's features are enforced on the server.
// Starter has no leave, no manager role, no daily summary; Business has leave and managers
// but no audit log; Pro and organisations from before plans have everything.
// Migration 20261103140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

const setPlan = (plan: string) => `update entitlements set plan = '${plan}', status = 'active', notes = null where organization_id = $1`;

describe("plan features", () => {
  it("refuses what the plan does not include, on the server", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Small Co");
    const worker = await addMember(t, org, "employee", "Worker");
    await t.su(setPlan("starter"), [org.id]);

    const features = await t.as<{ f: { plan: string; features: Record<string, boolean> } }>(worker.authId, "select public.get_prosm_time_plan_features() as f");
    expect(features.rows![0].f.plan).toBe("starter");
    expect(features.rows![0].f.features.leave).toBeUndefined();

    const leave = await t.as(worker.authId, "select public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, 'Family')");
    expect(leave.error).toMatch(/FEATURE NOT IN PLAN: leave/);
    expect((await t.as(org.owner.authId, "select public.get_prosm_time_daily_summary(current_date - 1)")).error).toMatch(/FEATURE NOT IN PLAN: daily_summary/);
    // the role is set at invitation (with the server's rights): the plan check runs there
    await expect(t.su("select public.prosm_time_check_role_plan($1, 'manager')", [org.id])).rejects.toThrow(/FEATURE NOT IN PLAN: roles_manager/);

    await t.su(setPlan("business"), [org.id]);
    await t.su("select public.prosm_time_check_role_plan($1, 'manager')", [org.id]);
    await expect(t.su("select public.prosm_time_check_role_plan($1, 'read_only')", [org.id])).rejects.toThrow(/FEATURE NOT IN PLAN: roles_all/);
    expect((await t.as(org.owner.authId, "select public.list_prosm_time_audit_log(null, null, null, null, null, 10)")).error).toMatch(/FEATURE NOT IN PLAN: audit/);

    await t.su(setPlan("pro"), [org.id]);
    expect((await t.as(org.owner.authId, "select public.get_prosm_time_daily_summary(current_date - 1)")).error).toBeNull();
  });

  it("keeps everything for organisations from before plans and for trials", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Old Co");
    await t.su("update entitlements set plan = 'legacy', status = 'active' where organization_id = $1", [org.id]);
    const old = await t.su<{ ok: boolean }>("select public.prosm_time_plan_allows($1, 'sos') as ok", [org.id]);
    expect(old[0].ok).toBe(true);
    await t.su("update entitlements set plan = 'starter', status = 'trial' where organization_id = $1", [org.id]);
    const trial = await t.su<{ ok: boolean }>("select public.prosm_time_plan_allows($1, 'audit') as ok", [org.id]);
    expect(trial[0].ok).toBe(true);
  });
});
