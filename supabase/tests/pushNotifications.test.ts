// Owner 2026-10-18/20: notifications reach phones even when the app is
// closed - device registration and the push hand-off. Migration 20261020100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let employee: TestMember;
let other: TestMember;
const TOKEN = "fcm-token-abcdefghijklmnopqrstuvwxyz-0123456789";

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  employee = await addMember(t, org, "employee", "Omar Hassan");
  other = await addMember(t, org, "employee", "Mona Elsayed");
});

describe("push notifications", () => {
  it("registers a phone for the signed-in person, who alone can see it", async () => {
    expect((await t.as(employee.authId, "select public.register_prosm_time_push_device($1, 'android')", [TOKEN])).error).toBeNull();
    expect((await t.as(employee.authId, "select token from push_devices")).rows).toHaveLength(1);
    expect((await t.as(other.authId, "select token from push_devices")).rows).toHaveLength(0);
    expect((await t.as(employee.authId, "insert into push_devices (organization_id, user_id, token, platform) values ($1, $2, 'x'||repeat('y', 30), 'android')", [org.id, other.userId])).error).toMatch(/permission denied/);
  });

  it("moves a phone to whoever signs in on it next, and forgets it on sign-out", async () => {
    expect((await t.as(other.authId, "select public.register_prosm_time_push_device($1, 'android')", [TOKEN])).error).toBeNull();
    const [row] = await t.su<{ user_id: string }>("select user_id from push_devices where token = $1", [TOKEN]);
    expect(row.user_id).toBe(other.userId);
    expect((await t.as(other.authId, "select public.unregister_prosm_time_push_device($1)", [TOKEN])).error).toBeNull();
    expect(await t.su("select 1 from push_devices where token = $1", [TOKEN])).toHaveLength(0);
  });

  it("gives send-push the message and the person's phones, and nobody else can ask", async () => {
    await t.as(employee.authId, "select public.register_prosm_time_push_device($1, 'android')", [TOKEN]);
    const [notification] = await t.su<{ id: string }>(
      "insert into notifications (organization_id, user_id, type, priority, title, body) values ($1, $2, 'sos_alert', 'high', 'SOS', 'Help needed') returning id",
      [org.id, employee.userId],
    );
    const [message] = await t.su<{ m: { title: string; tokens: string[]; priority: string } }>("select public.get_prosm_time_push_message($1) as m", [notification.id]);
    expect(message.m).toMatchObject({ title: "SOS", priority: "high", tokens: [TOKEN] });
    expect((await t.as(employee.authId, "select public.get_prosm_time_push_message($1)", [notification.id])).error).toMatch(/permission denied/);
  });
});
