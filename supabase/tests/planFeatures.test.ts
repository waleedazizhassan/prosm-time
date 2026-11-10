// 2026-11-03 (owner, the plans sheet): a plan's features are enforced on the server.
// 2026-11-10: four plans (migration 20261110100000). Starter has no leave, one manager and no
// supervisor, no daily summary, but SOS; Business has leave, the media centre and all managers but
// no audit log; Pro has payroll and the audit log but no API; Enterprise, trials and organisations
// from before plans have everything. External workers follow the number Platform Manager sets.
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
    expect(features.rows![0].f.features.sos).toBe(true);
    // the role is set at invitation (with the server's rights): the plan check runs there.
    // Starter: one manager, no supervisor.
    await t.su("select public.prosm_time_check_role_plan($1, 'manager')", [org.id]);
    await expect(t.su("select public.prosm_time_check_role_plan($1, 'supervisor')", [org.id])).rejects.toThrow(/FEATURE NOT IN PLAN: roles_manager/);
    await addMember(t, org, "manager", "The Manager");
    await expect(t.su("select public.prosm_time_check_role_plan($1, 'manager')", [org.id])).rejects.toThrow(/PLAN MANAGER LIMIT REACHED/);
    // the media centre is Business and up
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_department(null, 'Ops')")).error).toMatch(/FEATURE NOT IN PLAN: departments/);

    await t.su(setPlan("business"), [org.id]);
    await t.su("select public.prosm_time_check_role_plan($1, 'manager')", [org.id]);
    await expect(t.su("select public.prosm_time_check_role_plan($1, 'read_only')", [org.id])).rejects.toThrow(/FEATURE NOT IN PLAN: roles_all/);
    expect((await t.as(org.owner.authId, "select public.list_prosm_time_audit_log(null, null, null, null, null, 10)")).error).toMatch(/FEATURE NOT IN PLAN: audit/);

    await t.su(setPlan("pro"), [org.id]);
    expect((await t.as(org.owner.authId, "select public.get_prosm_time_daily_summary(current_date - 1)")).error).toBeNull();
    const allows = async (feature: string) => (await t.su<{ ok: boolean }>("select public.prosm_time_plan_allows($1, $2) as ok", [org.id, feature]))[0].ok;
    expect(await allows("payroll")).toBe(true);
    expect(await allows("integrations")).toBe(false);
    expect(await allows("delegation")).toBe(false);

    await t.su(setPlan("enterprise"), [org.id]);
    expect(await allows("integrations")).toBe(true);
    expect(await allows("delegation")).toBe(true);
    expect(await allows("retention")).toBe(true);
  });

  it("refuses more external workers than the licence allows, and bills one user per 10", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Crew Co");
    const site = await createSite(t, org, "Yard");
    await t.su(setPlan("business"), [org.id]);
    await t.su("update license_activation_state set max_external_workers = 2 where organization_id = $1", [org.id]);
    const add = (n: string) => t.su("insert into site_workers (organization_id, site_id, full_name, worker_number) values ($1, $2, $3, $4)", [org.id, site, `W${n}`, n]);
    await add("100001");
    await add("100002");
    await expect(add("100003")).rejects.toThrow(/PLAN EXTERNAL WORKER LIMIT REACHED/);
    // a stopped worker frees a place
    await t.su("update site_workers set status = 'inactive' where worker_number = '100001' and organization_id = $1", [org.id]);
    await add("100003");
    await expect(t.su("update site_workers set status = 'active' where worker_number = '100001' and organization_id = $1", [org.id])).rejects.toThrow(/PLAN EXTERNAL WORKER LIMIT REACHED/);
    // the plan screen: employees + one user per 10 workers
    const status = (await t.as<{ s: { externalWorkers: number; maxExternalWorkers: number; billedUsers: number; employees: number } }>(org.owner.authId, "select public.get_prosm_time_plan_status() as s")).rows![0].s;
    expect(status.externalWorkers).toBe(2);
    expect(status.maxExternalWorkers).toBe(2);
    expect(status.billedUsers).toBe(status.employees + 1);
    // the licence refresh writes the number from Platform Manager (empty = no limit)
    await t.su("select public.refresh_prosm_time_license_state($1, 'ACTIVE', null, null, now() + interval '1 year', null, null)", [org.id]);
    await add("100004");
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
    expect(await allows("announcements")).toBe(true);
    expect(await allows("payroll")).toBe(false);

    await setPlatformPlan("8fc0af08-e6ca-4f39-a9e8-d9c2a981c660");
    expect(await plan()).toBe("pro");
    expect(await allows("payroll")).toBe(true);
    expect(await allows("integrations")).toBe(false);

    // 2026-11-10: Platform Manager's fourth plan
    await setPlatformPlan("e4b7f1a2-6c3d-4f5e-9a8b-7c6d5e4f3a21");
    expect(await plan()).toBe("enterprise");
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
