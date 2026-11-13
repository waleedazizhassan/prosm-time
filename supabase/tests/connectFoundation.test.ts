// PROSM Connect stage 1 - the foundation's acceptance (PROSM_Connect_Implementation.md §12, stage 1):
//   a company without the module sees nothing and the API refuses; nobody reads a request addressed to someone
//   else or sends in someone else's name; another company reaches nothing; the cleanup removes expired rows and
//   queues their files; internal numbers are unique and 001 is never given. Migration 20261114100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let starter: TestOrg;
let omar: TestMember;
let hasan: TestMember;
let mona: TestMember;
let outsider: TestMember;
let starterPerson: TestMember;
let site: string;

const send = (from: TestMember, values: Record<string, unknown>) => {
  const cols = Object.keys(values);
  return t.as<{ id: string }>(from.authId,
    `insert into connect_switchboard (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(values));
};
const rows = async (m: TestMember, sql: string, params: unknown[] = []) => {
  const r = await t.as<Record<string, unknown>>(m.authId, sql, params);
  if (r.error) throw new Error(r.error);
  return r.rows!;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Connect Co");
  other = await createOrg(t, "Other Co");
  starter = await createOrg(t, "Starter Co");
  await t.su("insert into entitlements (organization_id, plan, status) values ($1, 'starter', 'active') on conflict (organization_id) do update set plan = 'starter', status = 'active'", [starter.id]);
  site = await createSite(t, org, "Capital");
  omar = await addMember(t, org, "manager", "Omar");
  hasan = await addMember(t, org, "employee", "Hasan");
  mona = await addMember(t, org, "employee", "Mona");
  outsider = await addMember(t, other, "employee", "Outsider");
  starterPerson = await addMember(t, starter, "employee", "Sami");
  await assignToSite(t, site, hasan);
});

describe("PROSM Connect - the foundation", () => {
  it("gives everyone a unique internal number from 10, never 001", async () => {
    const [{ n, d }] = await t.su<{ n: number; d: number }>(
      "select count(*)::int as n, count(distinct ext)::int as d from connect_extensions where organization_id = $1", [org.id]);
    expect(n).toBeGreaterThanOrEqual(4);
    expect(d).toBe(n);
    const [{ low }] = await t.su<{ low: number }>("select min(ext::int) as low from connect_extensions where organization_id = $1", [org.id]);
    expect(low).toBe(10);
    const bad = await t.su("update connect_extensions set ext = '001' where user_id = $1", [hasan.userId]).then(() => null, (e: Error) => e.message);
    expect(bad).toMatch(/check/i);
  });

  it("a company without the module sees nothing and the server refuses", async () => {
    const features = (await rows(starterPerson, "select public.get_prosm_time_connect_features() as f"))[0].f as { enabled: boolean };
    expect(features.enabled).toBe(false);
    expect(await rows(starterPerson, "select * from connect_extensions")).toHaveLength(0);
    const colleague = await addMember(t, starter, "employee", "Sara");
    expect((await t.as(starterPerson.authId, "select public.prosm_time_connect_open_direct($1)", [colleague.userId])).error).toMatch(/FEATURE NOT IN PLAN/);
    expect((await send(starterPerson, { organization_id: starter.id, from_user: starterPerson.userId, to_user: colleague.userId, type: "message", body: "hi" })).error).toMatch(/row-level security/);
  });

  it("nobody sends in someone else's name, nor to another company", async () => {
    expect((await send(hasan, { organization_id: org.id, from_user: omar.userId, to_user: mona.userId, type: "message", body: "fake" })).error).toMatch(/row-level security/);
    expect((await send(hasan, { organization_id: org.id, from_user: hasan.userId, to_user: outsider.userId, type: "message", body: "x" })).error).toMatch(/row-level security/);
    expect((await send(outsider, { organization_id: org.id, from_user: outsider.userId, to_user: hasan.userId, type: "message", body: "x" })).error).toMatch(/row-level security/);
  });

  it("a request is read by its people only, and received once it is everyone's", async () => {
    const sent = await send(omar, { organization_id: org.id, from_user: omar.userId, to_user: hasan.userId, type: "message", body: "صبّة السقف خلصت؟" });
    expect(sent.error).toBeNull();
    const id = sent.rows![0].id;
    expect(await rows(hasan, "select id from connect_switchboard where id = $1", [id])).toHaveLength(1);
    expect(await rows(mona, "select id from connect_switchboard where id = $1", [id])).toHaveLength(0);
    expect(await rows(outsider, "select id from connect_switchboard where id = $1", [id])).toHaveLength(0);
    expect(await rows(hasan, "select id from public.list_prosm_time_connect_inbox()")).toHaveLength(1);
    // nobody else can mark it received; its recipient can - and then it is gone from the server
    expect((await rows(mona, "select public.prosm_time_connect_ack($1) as ok", [id]))[0].ok).toBe(false);
    expect((await rows(hasan, "select public.prosm_time_connect_ack($1) as ok", [id]))[0].ok).toBe(true);
    expect(await t.su("select id from connect_switchboard where id = $1", [id])).toHaveLength(0);
  });

  it("a conversation is its members' only", async () => {
    const conv = (await rows(omar, "select public.prosm_time_connect_open_direct($1) as id", [hasan.userId]))[0].id as string;
    expect((await rows(hasan, "select public.prosm_time_connect_open_direct($1) as id", [omar.userId]))[0].id).toBe(conv);
    expect(await rows(mona, "select id from connect_conversations where id = $1", [conv])).toHaveLength(0);
    expect((await send(mona, { organization_id: org.id, from_user: mona.userId, conversation_id: conv, type: "message", body: "x" })).error).toMatch(/row-level security/);
    expect((await send(hasan, { organization_id: org.id, from_user: hasan.userId, conversation_id: conv, type: "message", body: "تمام" })).error).toBeNull();
  });

  it("a message to a site reaches the people there at that moment", async () => {
    expect((await clockIn(t, hasan, site)).error).toBeNull();
    const sent = await send(omar, { organization_id: org.id, from_user: omar.userId, site_id: site, type: "site_broadcast", body: "اجتماع 2 الضهر" });
    expect(sent.error).toBeNull();
    const to = await t.su<{ recipient_id: string }>("select recipient_id from connect_receipts where item_id = $1", [sent.rows![0].id]);
    expect(to.map((r) => r.recipient_id)).toEqual([hasan.userId]);
  });

  it("the cleanup removes what expired and queues its file; a call left ringing is missed", async () => {
    const id = (await t.su<{ id: string }>("select gen_random_uuid() as id"))[0].id;
    const path = `${org.id}/${id}/photo.jpg`;
    expect((await send(omar, { id, organization_id: org.id, from_user: omar.userId, to_user: mona.userId, type: "image", attachment_path: path })).error).toBeNull();
    await t.su("update connect_switchboard set expires_at = now() - interval '1 minute' where id = $1", [id]);
    await t.su("insert into connect_calls (organization_id, caller_id, callee_id, media, created_at) values ($1, $2, $3, 'audio', now() - interval '2 minutes')", [org.id, omar.userId, mona.userId]);
    const [{ r }] = await t.su<{ r: { items: number; missedCalls: number } }>("select public.prosm_time_connect_cleanup() as r");
    expect(r.items).toBeGreaterThanOrEqual(1);
    expect(r.missedCalls).toBe(1);
    expect(await t.su("select id from connect_switchboard where id = $1", [id])).toHaveLength(0);
    expect(await t.su("select path from connect_storage_trash where path = $1", [path])).toHaveLength(1);
  });

  it("a meeting takes no more than its limit (4 with video), for every plan", async () => {
    const [{ id }] = await t.su<{ id: string }>("insert into connect_meetings (organization_id, host_id, media, max_peers) values ($1, $2, 'video', 4) returning id", [org.id, omar.userId]);
    const fourth = await addMember(t, org, "employee", "Karim");
    const fifth = await addMember(t, org, "employee", "Ahmed");
    // invitations (20261114120000): only the host and those invited join
    for (const m of [hasan, mona, fourth, fifth]) await t.su("insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id) values ($1, $2, $3, 'meeting_invite', $4)", [org.id, omar.userId, m.userId, id]);
    for (const m of [omar, hasan, mona]) expect((await t.as(m.authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toBeNull();
    expect((await t.as(fourth.authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toBeNull();
    expect((await t.as(fifth.authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toMatch(/FULL/);
    const bad = await t.su("insert into connect_meetings (organization_id, host_id, media, max_peers) values ($1, $2, 'video', 6)", [org.id, omar.userId]).then(() => null, (e: Error) => e.message);
    expect(bad).toMatch(/check/i);
  });

  it("private channels: each joins only their own (owner 2026-11-13; Realtime itself is tested on a local Supabase)", async () => {
    const join = async (m: TestMember, topic: string) => (await rows(m, "select public.prosm_time_connect_can_join($1) as ok", [topic]))[0].ok;
    expect(await join(hasan, `connect:user:${hasan.userId}`)).toBe(true);
    expect(await join(hasan, `connect:user:${mona.userId}`)).toBe(false);
    expect(await join(hasan, `connect:company:${org.id}`)).toBe(true);
    expect(await join(hasan, `connect:company:${other.id}`)).toBe(false);
    const conv = (await rows(omar, "select public.prosm_time_connect_open_direct($1) as id", [hasan.userId]))[0].id as string;
    expect(await join(hasan, `connect:conv:${conv}`)).toBe(true);
    expect(await join(mona, `connect:conv:${conv}`)).toBe(false);
    const [call] = await t.su<{ id: string }>("insert into connect_calls (organization_id, caller_id, callee_id, media) values ($1, $2, $3, 'video') returning id", [org.id, omar.userId, hasan.userId]);
    expect(await join(hasan, `connect:call:${call.id}`)).toBe(true);
    expect(await join(mona, `connect:call:${call.id}`)).toBe(false);
    expect(await join(outsider, `connect:user:${outsider.userId}`)).toBe(true);
    expect(await join(starterPerson, `connect:user:${starterPerson.userId}`)).toBe(false);
    expect(await join(hasan, `connect:user:${hasan.userId}:extra`)).toBe(false);
    expect(await join(hasan, "other:topic")).toBe(false);
  });

  it("an employee sees everyone's name, number and status - nothing else; another company nobody (20261114130000)", async () => {
    const list = (await rows(mona, "select public.list_prosm_time_connect_people() as r"))[0].r as { id: string; ext: string; presence: string; currentSiteName: string | null; email?: string }[];
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining([omar.userId, hasan.userId]));
    expect(list.every((p) => /^\d{2,6}$/.test(p.ext))).toBe(true);
    expect(list.find((p) => p.id === hasan.userId)?.presence).toBe("in");
    expect(list.find((p) => p.id === hasan.userId)?.currentSiteName).toBe("Capital");
    expect(list.some((p) => "email" in p || "national_id" in p)).toBe(false);
    expect(list.some((p) => p.id === outsider.userId)).toBe(false);
    expect((await rows(starterPerson, "select public.list_prosm_time_connect_people() as r"))[0].r).toEqual([]);
  });

  it("nothing in Connect is open to someone signed out", async () => {
    for (const table of ["connect_extensions", "connect_switchboard", "connect_receipts", "connect_conversations", "connect_calls", "connect_meetings", "connect_photo_proofs"]) {
      expect((await t.as(null, `select * from ${table}`)).error).toBeTruthy();
    }
  });
});
