// 2026-11-02 (plan stage 7.4): a new device alerts the person and the owner; the
// first device, a return to a known one and a reinstall do not. Migration 20261102150000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember } from "./support/fixtures";

const register = (t: TestDatabase, member: TestMember, id: string, platform: string, label: string) =>
  t.as(member.authId, "select public.register_prosm_time_device($1, $2, $3)", [id, platform, label]);

describe("new device alert", () => {
  it("speaks only for a device never seen", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Device Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const count = async (member: TestMember) => (await t.su("select id from notifications where type = 'new_device_login' and user_id = $1", [member.userId])).length;

    expect((await register(t, worker, "dev-aaaaaaaaaaaaaaaa", "android", "Android - A1")).error).toBeNull();
    expect(await count(worker)).toBe(0);

    await t.as(worker.authId, "delete from signed_in_devices").catch(() => undefined);
    await t.su("delete from signed_in_devices where user_id = $1", [worker.userId]);
    await register(t, worker, "dev-aaaaaaaaaaaaaaaa", "android", "Android - A1");
    await register(t, worker, "dev-reinstalled-aaaa", "android", "Android - A1");
    expect(await count(worker)).toBe(0);

    await register(t, worker, "dev-bbbbbbbbbbbbbbbb", "web", "Windows");
    expect(await count(worker)).toBe(1);
    expect(await count(org.owner)).toBe(1);
    const audit = await t.su("select id from audit_logs where action = 'security.new_device' and organization_id = $1", [org.id]);
    expect(audit).toHaveLength(1);
  });
});
