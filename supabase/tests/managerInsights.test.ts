// 2026-11-02 (docs/IDEAS.md): no-show and overtime-soon alerts, the morning summary,
// attendance insights, roster cost and project budgets. Migration 20261102180000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("manager insights", () => {
  it("tells the site's managers and the owner about a no-show, once", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Alert Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Late Worker");
    const manager = await addMember(t, org, "manager", "Yard Manager");
    await assignToSite(t, site, worker);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
    await t.su("update sites set timezone = 'UTC' where id = $1", [site]);
    await t.su(
      "insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, ((now() at time zone 'UTC') - interval '40 minutes')::date, ((now() at time zone 'UTC') - interval '40 minutes')::time, ((now() at time zone 'UTC') + interval '6 hours')::time)",
      [org.id, worker.userId, site],
    );
    await t.su("select public.process_prosm_time_manager_alerts()");
    await t.su("select public.process_prosm_time_manager_alerts()");
    const sent = await t.su<{ user_id: string }>("select user_id from notifications where type = 'shift_no_show'");
    expect(sent.map((row) => row.user_id).sort()).toEqual([manager.userId, org.owner.userId].sort());
  });

  it("warns before a shift's end when the person is still in", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Soon Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Busy Worker");
    await assignToSite(t, site, worker);
    await t.su("update sites set shift_end_time = ((now() at time zone public.prosm_time_site_timezone(id, organization_id)) + interval '20 minutes')::time where id = $1", [site]);
    await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - interval '7 hours')", [org.id, worker.userId, site]);
    await t.su("select public.process_prosm_time_manager_alerts()");
    expect(await t.su("select id from notifications where type = 'overtime_soon' and user_id = $1", [org.owner.userId])).toHaveLength(1);
  });

  it("gives insights to those who see attendance, and roster cost and budgets to those who see pay", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Insight Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Worker");
    await assignToSite(t, site, worker);
    await t.su("insert into worker_pay_rates (organization_id, user_id, rate_type, rate_amount, currency, effective_from) values ($1, $2, 'HOURLY', 10, 'EGP', '2026-01-01')", [org.id, worker.userId]);
    await t.su("insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, '2026-10-05', '08:00', '18:00')", [org.id, worker.userId, site]);

    const insights = await t.as<{ r: { scheduled: number } }>(org.owner.authId, "select public.get_prosm_time_attendance_insights('2026-10-01', '2026-10-31') as r");
    expect(insights.error).toBeNull();
    expect(insights.rows![0].r.scheduled).toBe(1);
    expect((await t.as(worker.authId, "select public.get_prosm_time_attendance_insights('2026-10-01', '2026-10-31')")).error).toMatch(/AUTHORITY REQUIRED/);

    const cost = await t.as<{ r: { regularHours: number; overtimeHours: number; regularCost: number } }>(org.owner.authId, "select public.get_prosm_time_schedule_cost($1, '2026-10-01', '2026-10-31') as r", [site]);
    expect(cost.rows![0].r).toMatchObject({ regularHours: 8, overtimeHours: 2, regularCost: 80 });
    expect((await t.as(worker.authId, "select public.get_prosm_time_schedule_cost($1, '2026-10-01', '2026-10-31')", [site])).error).toMatch(/PAYROLL AUTHORITY/);

    const [project] = await t.su<{ id: string }>("insert into projects (site_id, name) values ($1, 'Line 2') returning id", [site]);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_project_budget($1, 5000)", [project.id])).error).toBeNull();
    const budgets = await t.as<{ budget: string }>(org.owner.authId, "select * from public.list_prosm_time_project_budgets()");
    expect(Number(budgets.rows![0].budget)).toBe(5000);
  });
});
