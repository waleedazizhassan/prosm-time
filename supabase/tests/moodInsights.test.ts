// Owner 2026-11-12: a site is the company's or a client's (with a type), and the shift ratings are a KPI by
// site and by client for any period. Migration 20261112140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite } from "./support/fixtures";

describe("site client and mood KPI", () => {
  it("names the client once, and scores the ratings by site and client", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Mood Co");
    const own = await createSite(t, org, "HQ");
    const store = await createSite(t, org, "Store");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    await assignToSite(t, own, amira);
    await assignToSite(t, store, omar);
    const profile = (site: string, kind: string, client: string | null, type: string | null, other: string | null, who = org.owner.authId) =>
      t.as(who, "select public.set_prosm_time_site_profile($1, $2, $3, $4, $5)", [site, kind, client, type, other]);

    expect((await profile(store, "client", "  ", "warehouse", null)).error).toMatch(/CLIENT NAME REQUIRED/);
    expect((await profile(store, "client", "Nile Foods", "other", null)).error).toMatch(/SITE TYPE NAME REQUIRED/);
    expect((await profile(store, "client", "Nile Foods", "warehouse", null, amira.authId)).error).toMatch(/SITES.MANAGE/);
    expect((await profile(store, "client", "Nile Foods", "warehouse", null)).error).toBeNull();
    expect((await profile(own, "client", "nile   foods", "office", null)).error).toBeNull();
    const [row] = await t.su<{ client_name: string }>("select client_name from sites where id = $1", [own]);
    expect(row.client_name).toBe("Nile Foods"); // the existing spelling
    expect((await profile(own, "company", "ignored", "office", null)).error).toBeNull();

    for (const [member, site, mood] of [[amira, own, "great"], [omar, store, "tough"]] as const) {
      expect((await clockIn(t, member, site)).error).toBeNull();
      expect((await clockOut(t, member)).error).toBeNull();
      const [s] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1 order by clock_in_at desc limit 1", [member.userId]);
      expect((await t.as(member.authId, "select public.set_prosm_time_shift_mood($1, $2)", [s.id, mood])).error).toBeNull();
    }
    const r = await t.as<{ r: { total: number; score: number; bySite: { name: string; score: number }[]; byClient: { client: string | null; score: number }[]; byDay: unknown[] } }>(
      org.owner.authId, "select public.get_prosm_time_mood_insights(current_date - 3, current_date + 1) as r");
    expect(r.error).toBeNull();
    const k = r.rows![0].r;
    expect(k).toMatchObject({ total: 2, score: 50 });
    expect(k.bySite).toEqual(expect.arrayContaining([expect.objectContaining({ name: "HQ", score: 100 }), expect.objectContaining({ name: "Store", score: 0 })]));
    expect(k.byClient).toEqual(expect.arrayContaining([expect.objectContaining({ client: null, score: 100 }), expect.objectContaining({ client: "Nile Foods", score: 0 })]));
    expect(k.byDay.length).toBeGreaterThan(0);
    expect((await t.as(amira.authId, "select public.get_prosm_time_mood_insights(current_date - 3, current_date)")).error).toMatch(/ATTENDANCE.VIEW/);
  });
});
