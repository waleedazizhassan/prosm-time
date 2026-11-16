// 2026-11-10 (owner): Buzz - the owner, a manager or a supervisor with authority over a person sends
// them a vibrating, sounding notification; nobody else can, and not twice within 30 seconds.
// Migrations 20261110170000, 20261116100000 (more ready reasons).
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("buzz", () => {
  it("the owner and the person's site manager can buzz; an employee and another site's manager cannot", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Buzz Co");
    const main = await createSite(t, org, "Main");
    const other = await createSite(t, org, "Other");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    const manager = await addMember(t, org, "manager", "Mona");
    const elsewhere = await addMember(t, org, "manager", "Karim");
    await assignToSite(t, main, amira);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [main, manager.userId]);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [other, elsewhere.userId]);

    const buzz = (authId: string, userId: string, reason = "clock_in", message: string | null = null) =>
      t.as<{ r: { success: boolean } }>(authId, "select public.send_prosm_time_buzz($1, $2, $3) as r", [userId, reason, message]);

    expect((await buzz(org.owner.authId, amira.userId)).error).toBeNull();
    expect((await buzz(manager.authId, amira.userId, "call_me")).error).toBeNull();
    expect((await buzz(omar.authId, amira.userId)).error).toMatch(/PERMISSION DENIED/);
    expect((await buzz(elsewhere.authId, amira.userId)).error).toMatch(/PERMISSION DENIED/);
    expect((await buzz(manager.authId, manager.userId)).error).toMatch(/YOU CANNOT BUZZ YOURSELF/);
    expect((await buzz(org.owner.authId, amira.userId, "dance")).error).toMatch(/INVALID BUZZ REASON/);

    // not twice within 30 seconds from the same sender
    expect((await buzz(org.owner.authId, amira.userId, "clock_out")).error).toMatch(/BUZZ TOO SOON/);

    const rows = await t.su<{ type: string; data: { reason: string; fromName: string } }>(
      "select type, data from notifications where user_id = $1 and type = 'buzz' order by created_at", [amira.userId]);
    expect(rows.map((r) => r.data.reason)).toEqual(["clock_in", "call_me"]);
    expect(rows[1].data.fromName).toBe("Mona");
  });

  it("the new ready reasons are accepted, each with its own text", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Buzz More");
    const amira = await addMember(t, org, "employee", "Amira");
    const reasons = ["go_home_early", "tomorrow_off", "dont_be_late", "end_break", "come_to_office", "check_messages", "shift_changed", "well_done"];
    for (const reason of reasons) {
      // one at a time: the 30-second rule is per sender, so the previous buzz is moved back first
      await t.su("update notifications set created_at = now() - interval '1 minute' where user_id = $1", [amira.userId]);
      expect((await t.as(org.owner.authId, "select public.send_prosm_time_buzz($1, $2, null)", [amira.userId, reason])).error).toBeNull();
    }
    const rows = await t.su<{ body: string; data: { reason: string } }>(
      "select body, data from notifications where user_id = $1 and type = 'buzz' order by created_at", [amira.userId]);
    expect(rows.map((r) => r.data.reason).sort()).toEqual([...reasons].sort());
    expect(new Set(rows.map((r) => r.body)).size).toBe(reasons.length);
    expect(rows.every((r) => r.body !== "Please check the app.")).toBe(true);
  });
});
