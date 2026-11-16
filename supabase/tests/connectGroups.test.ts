// PROSM Connect G5 / G6 (owner 2026-11-15 / 16), migration 20261116190000: groups (create, admin, members, leave,
// messages reach every member), a reply carries what it answers, "typing" reaches only the conversation.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let omar: TestMember;
let hasan: TestMember;
let mona: TestMember;
let karim: TestMember;
let stranger: TestMember;
let group: string;

const groups = async (who: TestMember) =>
  ((await t.as<{ r: { id: string; title: string; members: { userId: string; role: string }[] }[] }>(who.authId, "select public.list_prosm_time_connect_groups() as r")).rows?.[0].r ?? []);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Groups Co");
  other = await createOrg(t, "Other Co");
  omar = await addMember(t, org, "employee", "Omar");
  hasan = await addMember(t, org, "employee", "Hasan");
  mona = await addMember(t, org, "employee", "Mona");
  karim = await addMember(t, org, "employee", "Karim");
  stranger = await addMember(t, other, "employee", "Stranger");
});

describe("groups", () => {
  it("created with a name and members (no one from another organisation); the creator is admin", async () => {
    const r = await t.as<{ id: string }>(omar.authId, "select public.prosm_time_connect_create_group('Site crew', $1) as id", [[hasan.userId, mona.userId, stranger.userId]]);
    expect(r.error).toBeNull();
    group = r.rows![0].id;
    const [g] = await groups(omar);
    expect(g.title).toBe("Site crew");
    expect(g.members.map((m) => m.userId).sort()).toEqual([omar.userId, hasan.userId, mona.userId].sort());
    expect(g.members.find((m) => m.userId === omar.userId)!.role).toBe("admin");
    expect(await groups(karim)).toEqual([]);
  });

  it("a message reaches every member but the sender, with what it replies to", async () => {
    const sent = await t.as<{ id: string }>(hasan.authId,
      "insert into connect_switchboard (organization_id, from_user, conversation_id, type, body, client_id, reply_to, reply_snippet) values ($1, $2, $3, 'message', 'on my way', 'r-1', 'c-0', 'where are you?') returning id",
      [org.id, hasan.userId, group]);
    expect(sent.error).toBeNull();
    const to = await t.su<{ recipient_id: string }>("select recipient_id from connect_receipts where item_id = $1", [sent.rows![0].id]);
    expect(to.map((r) => r.recipient_id).sort()).toEqual([omar.userId, mona.userId].sort());
    const [row] = await t.su<{ reply_to: string; reply_snippet: string }>("select reply_to, reply_snippet from connect_switchboard where id = $1", [sent.rows![0].id]);
    expect(row).toEqual({ reply_to: "c-0", reply_snippet: "where are you?" });
  });

  it("someone outside the group cannot write into it", async () => {
    const r = await t.as(karim.authId, "insert into connect_switchboard (organization_id, from_user, conversation_id, type, body) values ($1, $2, $3, 'message', 'hi')", [org.id, karim.userId, group]);
    expect(r.error).not.toBeNull();
  });

  it("only an admin adds, removes and renames", async () => {
    expect((await t.as(hasan.authId, "select public.prosm_time_connect_update_group($1, 'Mine', null, null)", [group])).error).toMatch(/ONLY A GROUP ADMIN/);
    expect((await t.as(omar.authId, "select public.prosm_time_connect_update_group($1, 'Night crew', $2, $3)", [group, [karim.userId], [mona.userId]])).error).toBeNull();
    const [g] = await groups(omar);
    expect(g.title).toBe("Night crew");
    expect(g.members.map((m) => m.userId).sort()).toEqual([omar.userId, hasan.userId, karim.userId].sort());
  });

  it("when the last admin leaves, the oldest member becomes admin", async () => {
    expect((await t.as(omar.authId, "select public.prosm_time_connect_leave_group($1)", [group])).error).toBeNull();
    expect(await groups(omar)).toEqual([]);
    const [g] = await groups(hasan);
    expect(g.members.find((m) => m.userId === hasan.userId)!.role).toBe("admin");
  });

  it("typing from someone outside the conversation does nothing (no error, nothing sent)", async () => {
    expect((await t.as(mona.authId, "select public.prosm_time_connect_typing($1)", [group])).error).toBeNull();
    expect((await t.as(hasan.authId, "select public.prosm_time_connect_typing($1)", [group])).error).toBeNull();
  });
});
