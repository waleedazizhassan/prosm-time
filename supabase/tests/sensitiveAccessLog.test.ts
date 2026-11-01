// 2026-11-01 (plan stage 7.5): opening an attendance photo is recorded; the owner
// reads the log, and nobody writes to it directly. Migration 20261101140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("sensitive access log", () => {
  it("records who opened a photo, for the owner's eyes only", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Log Co");
    const other = await createOrg(t, "Other Log Co");
    const manager = await addMember(t, org, "manager", "Manager");

    expect((await t.as(manager.authId, "select public.log_prosm_time_sensitive_access('attendance_photo', 'org/user/photo.jpg')")).error).toBeNull();

    const read = "select actor_user_id, kind from sensitive_access_log";
    expect((await t.as<{ actor_user_id: string }>(org.owner.authId, read)).rows).toEqual([{ actor_user_id: manager.userId, kind: "attendance_photo" }]);
    expect((await t.as(manager.authId, read)).rows).toHaveLength(0);
    expect((await t.as(other.owner.authId, read)).rows).toHaveLength(0);
    expect((await t.as(manager.authId, "delete from sensitive_access_log")).error).not.toBeNull();
  });
});
