// PROSM Connect (owner 2026-11-16: "delete the call log"), migration 20261116140000: a person removes calls from
// THEIR log - one or all; the other person's log and the organisation's record stay.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let amal: TestMember;
let basem: TestMember;
let first: string;
let second: string;

const calls = async (who: TestMember) =>
  ((await t.as<{ r: { id: string }[] }>(who.authId, "select public.list_prosm_time_connect_calls() as r")).rows?.[0].r ?? []).map((c) => c.id).sort();

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "CallLog");
  amal = await addMember(t, org, "employee", "Amal");
  basem = await addMember(t, org, "employee", "Basem");
  // two calls between them, written as the call functions would leave them
  [{ id: first }] = await t.su<{ id: string }>("insert into connect_calls (organization_id, caller_id, callee_id, media, status, ended_at) values ($1, $2, $3, 'audio', 'ended', now()) returning id", [org.id, amal.userId, basem.userId]);
  [{ id: second }] = await t.su<{ id: string }>("insert into connect_calls (organization_id, caller_id, callee_id, media, status) values ($1, $2, $3, 'video', 'missed') returning id", [org.id, basem.userId, amal.userId]);
});

describe("removing calls from my log", () => {
  it("one call: gone from my log only", async () => {
    expect((await t.as(amal.authId, "select public.prosm_time_connect_hide_calls($1)", [[first]])).error).toBeNull();
    expect(await calls(amal)).toEqual([second]);
    expect(await calls(basem)).toEqual([first, second].sort());
  });

  it("all: my log is empty; the other person's and the organisation's record stay", async () => {
    expect((await t.as(amal.authId, "select public.prosm_time_connect_hide_calls(null)")).error).toBeNull();
    expect(await calls(amal)).toEqual([]);
    expect(await calls(basem)).toEqual([first, second].sort());
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from connect_calls where organization_id = $1", [org.id]);
    expect(n).toBe(2);
  });

  it("someone else's call cannot be hidden for them, and the hidden list is not readable directly", async () => {
    const other = await addMember(t, org, "employee", "Other");
    expect((await t.as<{ n: number }>(other.authId, "select public.prosm_time_connect_hide_calls(null) as n")).rows?.[0].n).toBe(0);
    expect(await calls(basem)).toEqual([first, second].sort());
    expect((await t.as(amal.authId, "select * from connect_call_hidden")).error).toMatch(/permission denied/);
  });
});
