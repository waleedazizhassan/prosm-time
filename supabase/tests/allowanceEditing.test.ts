// Owner 2026-10-18: allowances stay editable until a manager approves them.
// Migration 20261018110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let emp: TestMember;

const save = (date: string, meal: number) => t.as(emp.authId, "select public.upsert_prosm_time_allowance_entry($1::date, $2) as r", [date, meal]);
const entry = async (date: string) =>
  (await t.su<{ id: string; status: string; meal_allowance: number }>("select id, status, meal_allowance::float8 as meal_allowance from allowance_entries where user_id = $1 and entry_date = $2", [emp.userId, date]))[0];
const submit = async (date: string) => t.as(emp.authId, "select public.submit_prosm_time_allowance_entry($1)", [(await entry(date)).id]);
const review = async (date: string, action: "approved" | "rejected") => t.as(org.owner.authId, "select public.approve_prosm_time_allowance_entry($1, $2, null)", [(await entry(date)).id, action]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  emp = await addMember(t, org, "employee", "Omar Hassan");
});

describe("allowances editable until approved", () => {
  it("lets the employee change a submitted entry, which stays waiting for review", async () => {
    expect((await save("2026-10-01", 100)).error).toBeNull();
    expect((await submit("2026-10-01")).error).toBeNull();
    expect((await save("2026-10-01", 150)).error).toBeNull();
    expect(await entry("2026-10-01")).toMatchObject({ status: "submitted", meal_allowance: 150 });
  });

  it("returns a rejected entry to draft when it is edited, so it can be resubmitted", async () => {
    expect((await save("2026-10-02", 80)).error).toBeNull();
    expect((await submit("2026-10-02")).error).toBeNull();
    expect((await review("2026-10-02", "rejected")).error).toBeNull();
    expect((await save("2026-10-02", 90)).error).toBeNull();
    expect(await entry("2026-10-02")).toMatchObject({ status: "draft", meal_allowance: 90 });
    expect((await submit("2026-10-02")).error).toBeNull();
  });

  it("locks an approved entry", async () => {
    expect((await save("2026-10-03", 60)).error).toBeNull();
    expect((await submit("2026-10-03")).error).toBeNull();
    expect((await review("2026-10-03", "approved")).error).toBeNull();
    expect((await save("2026-10-03", 999)).error).toMatch(/ALREADY APPROVED/);
    expect(await entry("2026-10-03")).toMatchObject({ status: "approved", meal_allowance: 60 });
  });
});
