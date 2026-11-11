// 2026-11-09 KPI review (migration 20261109100000): today's figures do not depend on the chosen
// period; a weekly rest day makes nobody absent; someone whose day has not started is not absent.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember; // clocked in today, late
let missing: TestMember; // no attendance today
type Kpi = { absentToday: number; lateToday: number; onLeaveToday: number };
type Dash = { kpi: Kpi; absence: { userId: string; state: string }[]; sites: { id: string; absent: number; late: number }[] };

const cairoToday = "(now() at time zone 'Africa/Cairo')::date";
const dashboard = async (from: string, to: string) => {
  const result = await t.as<{ d: Dash }>(org.owner.authId, `select public.get_prosm_time_manager_dashboard(${from}, ${to}, 'org', null, 'Africa/Cairo') as d`);
  if (result.error) throw new Error(result.error);
  return result.rows![0].d;
};
const absentIds = (d: Dash) => d.absence.filter((row) => row.state === "absent").map((row) => row.userId);

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Today Co");
  site = await createSite(t, org, "Main");
  worker = await addMember(t, org, "employee", "Came Late");
  missing = await addMember(t, org, "employee", "Did Not Come");
  for (const member of [worker, missing]) await assignToSite(t, site, member);
  // no weekly rest day today, the site day started at midnight
  await t.su("update organization_settings set rest_days = '{}' where organization_id = $1", [org.id]);
  await t.su("update sites set rest_days = null, shift_start_time = '00:00', timezone = 'Africa/Cairo' where id = $1", [site]);
  // the worker clocked in an hour ago, two hours after a shift that started three hours ago
  await t.su(
    `insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time)
     values ($1, $2, $3, ${cairoToday}, ((now() - interval '3 hours') at time zone 'Africa/Cairo')::time(0), ((now() + interval '5 hours') at time zone 'Africa/Cairo')::time(0))`,
    [org.id, worker.userId, site],
  ).catch(() => undefined);
  await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - interval '1 hour')", [org.id, worker.userId, site]);
});

describe("today's figures", () => {
  it("are the same whatever period is chosen", async () => {
    const thisMonth = await dashboard(`${cairoToday} - 3`, cairoToday);
    const lastMonth = await dashboard(`${cairoToday} - 60`, `${cairoToday} - 31`);
    expect(absentIds(lastMonth)).toEqual(absentIds(thisMonth));
    expect(lastMonth.kpi.absentToday).toBe(thisMonth.kpi.absentToday);
    expect(lastMonth.kpi.lateToday).toBe(thisMonth.kpi.lateToday);
    expect(absentIds(lastMonth)).not.toContain(worker.userId);
  });

  it("make nobody absent on the weekly rest day (no schedule)", async () => {
    await t.su("delete from shift_assignments where organization_id = $1", [org.id]);
    expect(absentIds(await dashboard(cairoToday, cairoToday))).toContain(missing.userId);
    await t.su(`update organization_settings set rest_days = array[extract(dow from ${cairoToday})::smallint] where organization_id = $1`, [org.id]);
    const restDay = await dashboard(cairoToday, cairoToday);
    expect(absentIds(restDay)).not.toContain(missing.userId);
    expect(restDay.kpi.absentToday).toBe(0);
    await t.su("update organization_settings set rest_days = '{}' where organization_id = $1", [org.id]);
  });

  it("do not count someone absent before their day starts", async () => {
    const shift = (startMinutes: number) =>
      t.su(
        `insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time)
         values ($1, $2, $3, ${cairoToday},
           -- kept inside today in Cairo whatever the hour (it wrapped past midnight in the evening)
           least(greatest((now() at time zone 'Africa/Cairo') + make_interval(mins => $4), date_trunc('day', now() at time zone 'Africa/Cairo')),
                 date_trunc('day', now() at time zone 'Africa/Cairo') + interval '23 hours 58 minutes')::time(0), time '23:59:59')`,
        [org.id, missing.userId, site, startMinutes],
      );
    await shift(180); // starts in three hours
    const before = await dashboard(cairoToday, cairoToday);
    expect(absentIds(before)).not.toContain(missing.userId);
    await t.su("delete from shift_assignments where user_id = $1", [missing.userId]);
    await shift(-60); // started an hour ago, still not in
    const after = await dashboard(cairoToday, cairoToday);
    expect(absentIds(after)).toContain(missing.userId);
    // the card, the list and the sites table agree
    expect(after.kpi.absentToday).toBe(absentIds(after).length);
    expect(after.sites.find((row) => row.id === site)?.absent).toBe(1);
  });

  it("the overview card agrees, and someone who worked and clocked out today is not absent", async () => {
    await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() - interval '5 minutes' where user_id = $1", [worker.userId]);
    const d = await dashboard(cairoToday, cairoToday);
    const summary = await t.as<{ s: { absent: number; present: number } }>(org.owner.authId, `select public.get_prosm_time_dashboard_summary(${cairoToday} - 3, 'Africa/Cairo') as s`);
    expect(summary.error).toBeNull();
    expect(summary.rows![0].s.present).toBe(0);
    expect(summary.rows![0].s.absent).toBe(d.kpi.absentToday);
    expect(absentIds(d)).not.toContain(worker.userId);
  });
});
