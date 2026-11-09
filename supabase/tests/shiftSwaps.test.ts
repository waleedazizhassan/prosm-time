// 2026-11-02 (plan stage 8.3): a shift goes to a colleague only with a manager's
// approval, and never over leave or another shift. Migration 20261102120000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

async function setup(t: TestDatabase, name: string) {
  const org = await createOrg(t, name);
  const site = await createSite(t, org, `${name} Yard`);
  const giver = await addMember(t, org, "employee", "Giver");
  const taker = await addMember(t, org, "employee", "Taker");
  for (const member of [giver, taker]) await assignToSite(t, site, member);
  return { org, site, giver, taker };
}

async function shift(t: TestDatabase, org: TestOrg, site: string, member: TestMember, date: string) {
  const [row] = await t.su<{ id: string }>(
    "insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, $4, '08:00', '16:00') returning id",
    [org.id, member.userId, site, date],
  );
  return row.id;
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const request = (t: TestDatabase, member: TestMember, id: string, to: string) => t.as<{ id: string }>(member.authId, "select public.request_prosm_time_shift_swap($1, $2) as id", [id, to]);

describe("shift swaps", () => {
  it("moves the shift when a manager approves, and only then", async () => {
    const t = await buildDatabase();
    const { org, site, giver, taker } = await setup(t, "Swap");
    const id = await shift(t, org, site, giver, future(3));

    const asked = await request(t, giver, id, taker.userId);
    expect(asked.error).toBeNull();
    const swapId = asked.rows![0].id;
    expect((await t.as(giver.authId, "select public.decide_prosm_time_shift_swap($1, true)", [swapId])).error).toMatch(/YOUR OWN REQUEST|DO NOT MANAGE/);
    expect((await t.su<{ user_id: string }>("select user_id from shift_assignments where id = $1", [id]))[0].user_id).toBe(giver.userId);

    expect((await t.as(org.owner.authId, "select public.decide_prosm_time_shift_swap($1, true)", [swapId])).error).toBeNull();
    expect((await t.su<{ user_id: string }>("select user_id from shift_assignments where id = $1", [id]))[0].user_id).toBe(taker.userId);
    expect((await t.as(org.owner.authId, "select public.decide_prosm_time_shift_swap($1, false)", [swapId])).error).toMatch(/ALREADY DECIDED/);
  });

  it("refuses someone else's shift, an overlap, and a person from another site", async () => {
    const t = await buildDatabase();
    const { org, site, giver, taker } = await setup(t, "Guard");
    const outsider = await addMember(t, org, "employee", "Outsider");
    const date = future(4);
    const id = await shift(t, org, site, giver, date);
    await shift(t, org, site, taker, date);

    expect((await request(t, taker, id, giver.userId)).error).toMatch(/SHIFT NOT FOUND/);
    expect((await request(t, giver, id, outsider.userId)).error).toMatch(/NOT AT THIS SITE/);
    const asked = await request(t, giver, id, taker.userId);
    expect((await t.as(org.owner.authId, "select public.decide_prosm_time_shift_swap($1, true)", [asked.rows![0].id])).error).toMatch(/OVERLAPPING/);
    expect((await t.su<{ status: string }>("select status from shift_swap_requests"))[0].status).toBe("pending");
  });
});
