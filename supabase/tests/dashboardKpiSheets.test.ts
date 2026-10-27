// v2.3.54 (owner 2026-10-27): each KPI card opens the people behind its
// number; the per-person rows add up to the card. Migration 20261027100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let a: TestMember;
let b: TestMember;

type Person = { userId: string; days: number; workedMinutes: number; overtimeMinutes: number; lateDays: number; siteName: string | null };
type Dash = { kpi: { workedMinutes: number; overtimeMinutes: number; lateCount: number }; byPerson: Person[] };

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Sheets Co");
  const site = await createSite(t, org, "Main");
  a = await addMember(t, org, "employee", "Alaa");
  b = await addMember(t, org, "employee", "Basma");
  for (const member of [a, b]) await assignToSite(t, site, member);
  const session = (member: TestMember, from: string, to: string) =>
    t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', $4, $5)", [org.id, member.userId, site, from, to]);
  await session(a, `${yesterday}T05:00:00Z`, `${yesterday}T15:00:00Z`);
  await session(b, `${yesterday}T07:30:00Z`, `${yesterday}T12:00:00Z`);
});

describe("KPI sheets", () => {
  it("each person's row, and the rows add up to the cards", async () => {
    const result = await t.as<{ d: Dash }>(org.owner.authId, "select public.get_prosm_time_manager_dashboard($1, $1, 'org', null, 'Africa/Cairo') as d", [yesterday]);
    expect(result.error).toBeNull();
    const d = result.rows![0].d;
    expect(d.byPerson.map((person) => person.userId).sort()).toEqual([a.userId, b.userId].sort());
    const sum = (key: keyof Person) => d.byPerson.reduce((total, person) => total + Number(person[key]), 0);
    expect(sum("workedMinutes")).toBe(Number(d.kpi.workedMinutes));
    expect(sum("overtimeMinutes")).toBe(Number(d.kpi.overtimeMinutes));
    expect(sum("lateDays")).toBe(Number(d.kpi.lateCount));
    expect(d.byPerson[0].userId).toBe(a.userId); // most hours first
    expect(d.byPerson[0].siteName).toBe("Main");
  });
});
