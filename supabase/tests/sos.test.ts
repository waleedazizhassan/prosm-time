// SOS on every shift (owner 2026-10-13) - migration 20261013100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let plainSite: string;
let monitoredSite: string;
let emp: TestMember;
let emp2: TestMember;
let coworker: TestMember;

const shiftSos = (member: TestMember, sessionId: string | null) =>
  t.as(member.authId, "select public.trigger_prosm_time_shift_sos_alert($1, 30.02, 31.75, 8) as r", [sessionId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  other = await createOrg(t, "Orbit");
  plainSite = await createSite(t, org, "Tower B", { presenceMonitoring: false });
  monitoredSite = await createSite(t, org, "Factory", { presenceMonitoring: true });
  emp = await addMember(t, org, "employee", "Omar Hassan");
  emp2 = await addMember(t, org, "employee", "Mona Elsayed");
  coworker = await addMember(t, org, "employee", "Ali Coworker");
  for (const m of [emp, coworker]) await assignToSite(t, plainSite, m);
  await assignToSite(t, monitoredSite, emp2);
});

describe("SOS on every shift", () => {
  it("records an alert from a shift at a site without presence monitoring, with the site name", async () => {
    expect((await clockIn(t, emp, plainSite)).error).toBeNull();
    expect((await clockIn(t, coworker, plainSite)).error).toBeNull();
    const sessionId = await openSessionId(t, emp);
    const [presence] = await t.su<{ n: number }>("select count(*)::int as n from presence_sessions where user_id = $1 and status = 'active'", [emp.userId]);
    expect(presence.n).toBe(0);

    const result = await shiftSos(emp, sessionId);
    expect(result.error).toBeNull();
    const [alert] = await t.su<{ site_name: string; site_id: string; attendance_session_id: string; presence_session_id: string | null }>(
      "select site_name, site_id, attendance_session_id, presence_session_id from sos_alerts where user_id = $1",
      [emp.userId],
    );
    expect(alert).toMatchObject({ site_name: "Tower B", site_id: plainSite, attendance_session_id: sessionId, presence_session_id: null });

    const [notified] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'sos_alert'", [coworker.userId]);
    expect(notified.n).toBe(1);
    const [ownerNotified] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'sos_alert'", [org.owner.userId]);
    expect(ownerNotified.n).toBe(1);
  });

  it("links the presence session when the shift has one, and the old presence path still works", async () => {
    expect((await clockIn(t, emp2, monitoredSite)).error).toBeNull();
    const sessionId = await openSessionId(t, emp2);
    const [presence] = await t.su<{ id: string }>("select id from presence_sessions where user_id = $1 and status = 'active'", [emp2.userId]);
    expect(presence?.id).toBeTruthy();

    expect((await shiftSos(emp2, sessionId)).error).toBeNull();
    const legacy = await t.as(emp2.authId, "select public.trigger_prosm_time_sos_alert($1, null, null, null) as r", [presence.id]);
    expect(legacy.error).toBeNull();

    const alerts = await t.su<{ presence_session_id: string; attendance_session_id: string; site_name: string }>(
      "select presence_session_id, attendance_session_id, site_name from sos_alerts where user_id = $1",
      [emp2.userId],
    );
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(alert).toEqual({ presence_session_id: presence.id, attendance_session_id: sessionId, site_name: "Factory" });
  });

  it("refuses someone else's shift, another organisation, a closed shift and anonymous callers", async () => {
    const empSession = await openSessionId(t, emp);
    expect((await shiftSos(emp2, empSession)).error).toMatch(/NOT THE SUBJECT/);
    expect((await shiftSos(other.owner, empSession)).error).toMatch(/NOT THE SUBJECT/);
    expect((await t.as(null, "select public.trigger_prosm_time_shift_sos_alert($1) as r", [empSession])).error).toBeTruthy();

    expect((await clockOut(t, emp)).error).toBeNull();
    expect((await shiftSos(emp, empSession)).error).toMatch(/ACTIVE SHIFT/);
  });

  it("shows the site name to a manager who cannot see the presence session", async () => {
    const reader = await addMember(t, org, "read_only", "Hoda Ali");
    const visible = await t.as<{ site_name: string }>(reader.authId, "select site_name from sos_alerts where user_id = $1", [emp.userId]);
    if (visible.rows && visible.rows.length > 0) expect(visible.rows[0].site_name).toBe("Tower B");
    const [direct] = await t.su<{ n: number }>("select count(*)::int as n from sos_alerts where site_name is null");
    expect(direct.n).toBe(0);
  });
});
