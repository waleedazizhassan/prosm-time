// 2026-11-11 (owner): "how was today's work?" after the clock-out. Migration 20261111170000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite } from "./support/fixtures";

describe("shift mood", () => {
  it("is set by the person on their own closed shift only", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Mood Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    await assignToSite(t, site, amira);
    expect((await clockIn(t, amira, site)).error).toBeNull();
    const [s] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [amira.userId]);
    const set = (authId: string, mood: string) => t.as(authId, "select public.set_prosm_time_shift_mood($1, $2)", [s.id, mood]);
    expect((await set(amira.authId, "great")).error).toMatch(/SESSION NOT FOUND/); // still open
    expect((await clockOut(t, amira)).error).toBeNull();
    expect((await set(omar.authId, "great")).error).toMatch(/SESSION NOT FOUND/);
    expect((await set(amira.authId, "angry")).error).toMatch(/INVALID MOOD/);
    expect((await set(amira.authId, "tough")).error).toBeNull();
    const [row] = await t.su<{ shift_mood: string }>("select shift_mood from attendance_sessions where id = $1", [s.id]);
    expect(row.shift_mood).toBe("tough");
  });
});
