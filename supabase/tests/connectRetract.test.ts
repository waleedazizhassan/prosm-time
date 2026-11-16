// PROSM Connect (owner 2026-11-16): delete my own message for everyone - migration 20261116150000. Only a member of the
// conversation can send the notice; a copy not fetched yet is removed; the notice reaches the other members (not the
// sender, not other organisations) and is never a switchboard item (older apps would show it as a message).
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let omar: TestMember;
let hasan: TestMember;
let mona: TestMember;
let stranger: TestMember;
let conv: string;

const retract = (who: TestMember, conversation: string | null, site: string | null, ids: string[]) =>
  t.as(who.authId, "select public.prosm_time_connect_retract($1, $2, $3)", [conversation, site, ids]);
const notices = async (who: TestMember) =>
  ((await t.as<{ r: { from: string; clientIds: string[] }[] }>(who.authId, "select public.list_prosm_time_connect_retractions(null) as r")).rows?.[0].r ?? []);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Retract Co");
  other = await createOrg(t, "Elsewhere");
  omar = await addMember(t, org, "employee", "Omar");
  hasan = await addMember(t, org, "employee", "Hasan");
  mona = await addMember(t, org, "employee", "Mona");
  stranger = await addMember(t, other, "employee", "Stranger");
  conv = (await t.as<{ id: string }>(omar.authId, "select public.prosm_time_connect_open_direct($1) as id", [hasan.userId])).rows![0].id;
});

describe("delete for everyone", () => {
  it("the sender's notice reaches the other member - not the sender, not someone outside the conversation", async () => {
    // a copy Hasan has not fetched yet
    await t.su("insert into connect_switchboard (organization_id, from_user, conversation_id, type, body, client_id) values ($1, $2, $3, 'message', 'oops', 'c-1')", [org.id, omar.userId, conv]);
    expect((await retract(omar, conv, null, ["c-1", "c-0"])).error).toBeNull();
    expect((await t.su("select 1 from connect_switchboard where client_id = 'c-1'")).length).toBe(0);
    expect(await notices(hasan)).toEqual([expect.objectContaining({ from: omar.userId, clientIds: ["c-1", "c-0"] })]);
    expect(await notices(omar)).toEqual([]);
    expect(await notices(mona)).toEqual([]);
    expect(await notices(stranger)).toEqual([]);
  });

  it("someone outside the conversation, or another organisation, cannot send a notice into it", async () => {
    expect((await retract(mona, conv, null, ["x"])).error).toMatch(/CONVERSATION NOT FOUND/);
    expect((await retract(stranger, conv, null, ["x"])).error).toMatch(/CONVERSATION NOT FOUND/);
  });

  it("the notice is never a switchboard item, and a sender cannot remove someone else's undelivered copy", async () => {
    await t.su("insert into connect_switchboard (organization_id, from_user, conversation_id, type, body, client_id) values ($1, $2, $3, 'message', 'mine', 'h-1')", [org.id, hasan.userId, conv]);
    expect((await retract(omar, conv, null, ["h-1"])).error).toBeNull();
    expect((await t.su("select 1 from connect_switchboard where client_id = 'h-1'")).length).toBe(1);
    expect((await t.su("select 1 from connect_switchboard where type not in ('message')")).length).toBe(0);
  });

  it("bad input is refused; the table is not readable directly", async () => {
    expect((await retract(omar, conv, null, [])).error).toMatch(/INVALID MESSAGES/);
    expect((await retract(omar, null, null, ["a"])).error).toMatch(/ONE CONVERSATION OR ONE SITE/);
    expect((await t.as(hasan.authId, "select * from connect_retractions")).error).toMatch(/permission denied/);
  });
});
