// Owner 2026-11-13: the swap's colleague list was empty for a shift without a site. Migration 20261113190000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let me: TestMember;
let mate: TestMember;
let busy: TestMember;
let viewer: TestMember;
let outside: string;

const shift = async (member: TestMember, site: string, start = "08:00", end = "16:00") => {
  const [row] = await t.su<{ id: string }>(
    "insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time, status) values ($1, $2, $3, current_date + 3, $4, $5, 'scheduled') returning id",
    [org.id, member.userId, site, start, end],
  );
  return row.id;
};
const names = async (member: TestMember, id: string) => {
  const r = await t.as<{ full_name: string }>(member.authId, "select full_name from public.list_prosm_time_swap_colleagues($1)", [id]);
  if (r.error) throw new Error(r.error);
  return r.rows!.map((x) => x.full_name);
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Swap Co");
  const site = await createSite(t, org, "Main");
  me = await addMember(t, org, "employee", "Mina");
  mate = await addMember(t, org, "employee", "Maged");
  busy = await addMember(t, org, "employee", "Basel");
  viewer = await addMember(t, org, "read_only", "Vera");
  for (const m of [me, mate, busy, viewer]) await assignToSite(t, site, m);
  await shift(busy, site, "07:00", "15:00");
  outside = await createSite(t, org, "Far", { latitude: 30.5, longitude: 31.5 });
});

describe("who one can swap a shift with", () => {
  it("a shift at a site one is not assigned to: colleagues of one's sites who are free that day", async () => {
    const id = await shift(me, outside);
    const list = await names(me, id);
    expect(list).toContain("Maged");
    expect(list).not.toContain("Basel");
    expect(list).not.toContain("Vera");
    const r = await t.as(me.authId, "select public.request_prosm_time_shift_swap($1, $2, 'family')", [id, mate.userId]);
    expect(r.error).toBeNull();
  });

  it("refuses someone not on the list", async () => {
    const id = await shift(me, outside, "18:00", "22:00");
    const r = await t.as(me.authId, "select public.request_prosm_time_shift_swap($1, $2, 'x')", [id, viewer.userId]);
    expect(r.error).toMatch(/NOT AT THIS SITE/);
  });

  it("one's own shifts come with their site's name", async () => {
    const r = await t.as<{ site_name: string }>(me.authId, "select site_name from public.list_prosm_time_my_shifts()");
    expect(r.rows!.map((x) => x.site_name)).toContain("Far");
  });
});
