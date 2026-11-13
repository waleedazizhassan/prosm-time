// Owner 2026-11-13: a limit on requests (first used by resolve-map-link). Migration 20261113240000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember } from "./support/fixtures";

let t: TestDatabase;
let a: TestMember;
let b: TestMember;
const take = async (m: TestMember) => (await t.as<{ ok: boolean }>(m.authId, "select public.prosm_time_take_rate_limit('resolve-map-link', 3, 600) as ok")).rows![0].ok;

beforeAll(async () => {
  t = await buildDatabase();
  const org = await createOrg(t, "Limit Co");
  a = await addMember(t, org, "employee", "Adel");
  b = await addMember(t, org, "employee", "Basma");
});

describe("rate limit", () => {
  it("allows up to the limit in a window, then refuses; each person counts apart", async () => {
    expect([await take(a), await take(a), await take(a)]).toEqual([true, true, true]);
    expect(await take(a)).toBe(false);
    expect(await take(b)).toBe(true);
  });

  it("is closed to anyone signed out, and its table to everyone", async () => {
    expect((await t.as(null, "select public.prosm_time_take_rate_limit('x', 1, 60)")).error).toBeTruthy();
    expect((await t.as(a.authId, "select * from public.rate_limit_hits")).error).toBeTruthy();
  });
});
