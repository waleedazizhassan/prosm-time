// 2026-11-03 (owner, the plans sheet): a plan's features are enforced on the server.
// Starter has no leave, no manager role, no daily summary; Business has leave and managers
// but no audit log; Pro and organisations from before plans have everything.
// Migration 20261103140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg, createSite } from "./support/fixtures";

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

  it("shows a plan's history window and keeps the older records (migration 20261103170000)", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "History Co");
    const worker = await addMember(t, org, "employee", "Worker");
    for (const ago of ["3 years", "1 year"]) {
      await t.su(`insert into attendance_sessions (organization_id, user_id, status, clock_in_at, clock_out_at, manual_location_label) values ($1, $2, 'clocked_out', now() - interval '${ago}', now() - interval '${ago}' + interval '8 hours', 'Yard')`, [org.id, worker.userId]);
    }
    await t.su(setPlan("starter"), [org.id]);
    expect((await t.as(worker.authId, "select id from attendance_sessions")).rows).toHaveLength(1);
    await t.su(setPlan("pro"), [org.id]);
    expect((await t.as(worker.authId, "select id from attendance_sessions")).rows).toHaveLength(2);
    expect(await t.su("select id from attendance_sessions where organization_id = $1", [org.id])).toHaveLength(2);
  });

  it("follows the plan Platform Manager sets, by itself (the licence sync writes plan_id)", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Switching Co");
    await t.su("update entitlements set plan = 'legacy', status = 'active', notes = 'existing before plans' where organization_id = $1", [org.id]);
    await t.su("update license_activation_state set is_trial = false where organization_id = $1", [org.id]);
    const allows = async (feature: string) => (await t.su<{ ok: boolean }>("select public.prosm_time_plan_allows($1, $2) as ok", [org.id, feature]))[0].ok;
    const plan = async () => (await t.su<{ plan: string }>("select plan from entitlements where organization_id = $1", [org.id]))[0].plan;
    const setPlatformPlan = (id: string) => t.su("update license_activation_state set plan_id = $2 where organization_id = $1", [org.id, id]);

    await setPlatformPlan("d6ff925e-5008-4fe0-899d-5a87453bc3f8");
    expect(await plan()).toBe("starter");
    expect(await allows("leave")).toBe(false);
    const existing = (await t.su("select id from sites where organization_id = $1", [org.id])).length;
    for (let i = existing; i < 3; i += 1) await createSite(t, org, `Site ${i}`);
    await expect(createSite(t, org, "D")).rejects.toThrow(/PLAN SITE LIMIT REACHED/);
    expect(await t.su("select id from sites where organization_id = $1", [org.id])).toHaveLength(3);

    await setPlatformPlan("be13be26-7496-47b4-b088-43eaf3079f74");
    expect(await plan()).toBe("business");
    expect(await allows("leave")).toBe(true);
    expect(await allows("sos")).toBe(false);

    await setPlatformPlan("8fc0af08-e6ca-4f39-a9e8-d9c2a981c660");
    expect(await plan()).toBe("pro");
    expect(await allows("sos")).toBe(true);
    // owner 2026-11-09: every plan includes the API until the packages session decides (20261109210000)
    expect(await allows("integrations")).toBe(true);
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
