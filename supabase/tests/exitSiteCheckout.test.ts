// v2.3.43 step 12 (item 24): leaving the site with the shift open - a quick
// in/out changes nothing, a weak reading is ignored, PROMPT asks once,
// "still working" stops AUTO, AUTO clocks out at the real exit time after
// the timeout (audited), field workers are never touched.
// Migration 20261025210000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;

const inside = { latitude: 30.02125, longitude: 31.75812 };
const outside = { latitude: 30.0312, longitude: 31.7681 }; // ~1.4 km away

async function presenceId() {
  const [row] = await t.su<{ id: string }>("select id from presence_sessions where user_id = $1 and status = 'active'", [worker.userId]);
  return row.id;
}
const sample = async (at: { latitude: number; longitude: number }, accuracy: number) =>
  t.as<{ r: { exit: Record<string, unknown> | null } }>(worker.authId, "select public.record_prosm_time_presence_sample($1, $2, $3, $4) as r", [await presenceId(), at.latitude, at.longitude, accuracy]);
const prompts = async () => (await t.su("select id from notifications where user_id = $1 and type = 'exit_site_prompt'", [worker.userId])).length;

async function freshShift() {
  await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = $1 and status = 'clocked_in'", [worker.userId]);
  await t.su("update presence_sessions set status = 'ended' where user_id = $1 and status = 'active'", [worker.userId]);
  await t.su("delete from notifications where user_id = $1", [worker.userId]);
  expect((await clockIn(t, worker, site, inside)).error).toBeNull();
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Hurghada");
  site = await createSite(t, org, "Marina", { radius: 150 });
  worker = await addMember(t, org, "employee", "Nour Samir");
  await assignToSite(t, site, worker);
  expect((await t.as(org.owner.authId, "select public.set_prosm_time_site_exit_policy($1, 'PROMPT', null, null)", [site])).error).toBeNull();
});

describe("leaving the site (item 24)", () => {
  it("setting a policy turns presence monitoring on; PROMPT asks once after two good outside readings", async () => {
    const [{ on }] = await t.su<{ on: boolean }>("select presence_monitoring_enabled as on from sites where id = $1", [site]);
    expect(on).toBe(true);
    await freshShift();
    expect((await sample(outside, 10)).error).toBeNull();
    expect(await prompts()).toBe(0);
    await sample(outside, 10);
    expect(await prompts()).toBe(1);
    await sample(outside, 10);
    expect(await prompts()).toBe(1);
  });

  it("a quick out and back, and weak readings, change nothing", async () => {
    await freshShift();
    await sample(outside, 10);
    await sample(inside, 10);
    await sample(outside, 10);
    expect(await prompts()).toBe(0);
    const weak = await sample(outside, 400);
    expect(weak.rows?.[0].r.exit).toEqual({ ignored: "weak_accuracy" });
    await sample(outside, 400);
    expect(await prompts()).toBe(0);
  });

  it("AUTO: after the timeout with no answer, clocked out at the time they left, audited", async () => {
    await t.as(org.owner.authId, "select public.set_prosm_time_site_exit_policy($1, 'AUTO', 10, null)", [site]);
    await freshShift();
    const sessionId = await openSessionId(t, worker);
    await t.su("update attendance_sessions set clock_in_at = now() - interval '3 hours' where id = $1", [sessionId]);
    await sample(outside, 10);
    await sample(outside, 10);
    await t.su("update presence_sessions set exit_since = now() - interval '15 minutes' where id = $1", [await presenceId()]);
    expect((await t.su<{ n: number }>("select public.process_prosm_time_site_exits() as n"))[0].n).toBe(1);
    const [row] = await t.su<{ status: string; auto_checkout_geofence: boolean; ago: number }>(
      "select status, auto_checkout_geofence, extract(epoch from (now() - clock_out_at)) / 60 as ago from attendance_sessions where id = $1",
      [sessionId],
    );
    expect(row.status).toBe("clocked_out");
    expect(row.auto_checkout_geofence).toBe(true);
    expect(Number(row.ago)).toBeCloseTo(15, 0);
    expect(await t.su("select id from audit_logs where action = 'attendance.auto_checkout_geofence' and entity_id = $1", [sessionId])).toHaveLength(1);
    expect(await t.su("select id from notifications where type = 'auto_checkout_geofence' and user_id = $1", [worker.userId])).toHaveLength(1);
  });

  it("'still working' stops the automatic clock-out", async () => {
    await freshShift();
    await sample(outside, 10);
    await sample(outside, 10);
    expect((await t.as(worker.authId, "select public.respond_prosm_time_site_exit('still_working')")).error).toBeNull();
    await t.su("update presence_sessions set exit_since = now() - interval '30 minutes' where id = $1", [await presenceId()]);
    expect((await t.su<{ n: number }>("select public.process_prosm_time_site_exits() as n"))[0].n).toBe(0);
    expect(await openSessionId(t, worker)).not.toBeNull();
  });

  it("a field worker is never prompted nor clocked out", async () => {
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_field_worker($1, true)", [worker.userId])).error).toBeNull();
    await freshShift();
    await sample(outside, 10);
    await sample(outside, 10);
    expect(await prompts()).toBe(0);
  });

  it("only the Owner (by default) sets the policy, and it is audited", async () => {
    const manager = await addMember(t, org, "manager", "Marina Manager");
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
    expect((await t.as(manager.authId, "select public.set_prosm_time_site_exit_policy($1, 'OFF', null, null)", [site])).error).toMatch(/EXIT_POLICY/);
    expect((await t.su("select id from audit_logs where action = 'sites.exit_policy'")).length).toBe(2);
  });
});
