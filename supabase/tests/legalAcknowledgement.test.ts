// Privacy Policy / Terms of Use acknowledgement (owner 2026-10-13).
// Migration 20261013210000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let emp: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  other = await createOrg(t, "Orbit");
  emp = await addMember(t, org, "employee", "Omar Hassan");
});

describe("legal acknowledgements", () => {
  it("records each person's acknowledgement once per version, and the Owner's for the organisation", async () => {
    for (let i = 0; i < 2; i += 1) expect((await t.as(emp.authId, "select public.acknowledge_prosm_time_legal('2026-10-13')")).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.acknowledge_prosm_time_legal('2026-10-13')")).error).toBeNull();
    const rows = await t.su<{ user_id: string; accepted_for_organization: boolean }>("select user_id, accepted_for_organization from legal_acknowledgements where organization_id = $1 order by acknowledged_at", [org.id]);
    expect(rows).toEqual([
      { user_id: emp.userId, accepted_for_organization: false },
      { user_id: org.owner.userId, accepted_for_organization: true },
    ]);
  });

  it("shows a person their own, the Owner the organisation's, and nothing to another organisation", async () => {
    const seen = async (member: TestMember) => ((await t.as(member.authId, "select user_id from legal_acknowledgements")).rows ?? []).length;
    expect(await seen(emp)).toBe(1);
    expect(await seen(org.owner)).toBe(2);
    expect(await seen(other.owner)).toBe(0);
  });

  it("cannot be written directly or anonymously", async () => {
    expect((await t.as(emp.authId, "insert into legal_acknowledgements (organization_id, user_id, version) values ($1, $2, 'x')", [org.id, emp.userId])).error).toMatch(/permission denied|row-level security/);
    expect((await t.as(null, "select public.acknowledge_prosm_time_legal('2026-10-13')")).error).not.toBeNull();
  });
});
