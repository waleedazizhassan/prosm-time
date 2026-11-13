// PROSM Connect stages 2-7 on the server: calls (ring, busy, answer, end, missed), meetings (invitations, the limit,
// only invitees join), the verified photo (server time, the site, the code, the fingerprint). Migration 20261114120000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let omar: TestMember;
let hasan: TestMember;
let mona: TestMember;
let karim: TestMember;
const people: TestMember[] = [];

const call = async <T,>(m: TestMember, sql: string, params: unknown[] = []) => {
  const r = await t.as<{ r: T }>(m.authId, sql, params);
  if (r.error) throw new Error(r.error);
  return r.rows![0].r;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Calls Co");
  await createSite(t, org, "Capital", { latitude: 30.0182, longitude: 31.7445 });
  omar = await addMember(t, org, "manager", "Omar");
  hasan = await addMember(t, org, "employee", "Hasan");
  mona = await addMember(t, org, "employee", "Mona");
  karim = await addMember(t, org, "employee", "Karim");
  for (let i = 0; i < 8; i++) people.push(await addMember(t, org, "employee", `Person ${i}`));
});

describe("calls", () => {
  it("rings, is answered and ended; a second caller hears busy", async () => {
    const started = await call<{ callId: string; status: string }>(omar, "select public.prosm_time_connect_start_call($1, 'video') as r", [hasan.userId]);
    expect(started.status).toBe("ringing");
    expect(await t.su("select item_id from connect_receipts where recipient_id = $1", [hasan.userId])).not.toHaveLength(0);
    expect((await t.as(mona.authId, "select public.prosm_time_connect_answer_call($1, 'accept')", [started.callId])).error).toMatch(/CALL NOT FOUND/);
    const answered = await call<{ status: string }>(hasan, "select public.prosm_time_connect_answer_call($1, 'accept') as r", [started.callId]);
    expect(answered.status).toBe("accepted");
    const busy = await call<{ status: string }>(mona, "select public.prosm_time_connect_start_call($1, 'audio') as r", [hasan.userId]);
    expect(busy.status).toBe("busy");
    const ended = await call<{ status: string }>(hasan, "select public.prosm_time_connect_end_call($1, 'hangup') as r", [started.callId]);
    expect(ended.status).toBe("ended");
    const log = await call<{ status: string }[]>(omar, "select public.list_prosm_time_connect_calls() as r");
    expect(log[0].status).toBe("ended");
  });

  it("an unanswered call becomes missed and leaves a missed-call notice", async () => {
    const started = await call<{ callId: string }>(mona, "select public.prosm_time_connect_start_call($1, 'audio') as r", [karim.userId]);
    const ended = await call<{ status: string }>(mona, "select public.prosm_time_connect_end_call($1, 'cancelled') as r", [started.callId]);
    expect(ended.status).toBe("missed");
    expect(await t.su("select id from connect_switchboard where to_user = $1 and type = 'missed'", [karim.userId])).toHaveLength(1);
  });

  it("a failed connection is recorded as failed", async () => {
    const started = await call<{ callId: string }>(omar, "select public.prosm_time_connect_start_call($1, 'audio') as r", [mona.userId]);
    await call(mona, "select public.prosm_time_connect_answer_call($1, 'accept') as r", [started.callId]);
    expect((await call<{ status: string }>(omar, "select public.prosm_time_connect_end_call($1, 'failed') as r", [started.callId])).status).toBe("failed");
  });
});

describe("meetings", () => {
  it("video: the host and up to 3 invitees; nobody else gets in", async () => {
    expect((await t.as(omar.authId, "select public.prosm_time_connect_start_meeting('video', $1)", [[hasan.userId, mona.userId, karim.userId, people[0].userId]])).error).toMatch(/FULL/);
    const id = await call<string>(omar, "select public.prosm_time_connect_start_meeting('video', $1, 'Site review') as r", [[hasan.userId, mona.userId, karim.userId]]);
    // the invitation is received (and leaves the server) before joining - joining still works (20261114150000)
    for (const m of [hasan, mona, karim]) {
      const [inv] = await t.su<{ item_id: string }>("select r.item_id from connect_receipts r join connect_switchboard s on s.id = r.item_id where s.ref_id = $1 and r.recipient_id = $2", [id, m.userId]);
      await t.as(m.authId, "select public.prosm_time_connect_ack($1)", [inv.item_id]);
    }
    expect(await t.su("select id from connect_switchboard where ref_id = $1", [id])).toHaveLength(0);
    for (const m of [hasan, mona, karim]) expect((await t.as(m.authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toBeNull();
    expect((await t.as(people[1].authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toMatch(/NOT INVITED|FULL/);
    const meeting = await call<{ peers: string[]; maxPeers: number }>(hasan, "select public.get_prosm_time_connect_meeting($1) as r", [id]);
    expect(meeting.peers).toHaveLength(4);
    expect(meeting.maxPeers).toBe(4);
    expect((await t.as(hasan.authId, "select public.prosm_time_connect_end_meeting($1)", [id])).error).toMatch(/ONLY THE HOST/);
    expect((await t.as(omar.authId, "select public.prosm_time_connect_end_meeting($1)", [id])).error).toBeNull();
  });

  it("sound only: up to 8 together", async () => {
    const invitees = people.slice(0, 7);
    const id = await call<string>(omar, "select public.prosm_time_connect_start_meeting('audio', $1) as r", [invitees.map((p) => p.userId)]);
    for (const p of invitees) expect((await t.as(p.authId, "select public.prosm_time_connect_join_meeting($1)", [id])).error).toBeNull();
    const meeting = await call<{ peers: string[] }>(omar, "select public.get_prosm_time_connect_meeting($1) as r", [id]);
    expect(meeting.peers).toHaveLength(8);
    for (const p of [omar, ...invitees]) await t.as(p.authId, "select public.prosm_time_connect_leave_meeting($1)", [id]);
    const [{ status }] = await t.su<{ status: string }>("select status from connect_meetings where id = $1", [id]);
    expect(status).toBe("ended");
  });
});

describe("verified photo", () => {
  it("gives the server's time, the nearest site and whether inside, and a code that checks", async () => {
    const proof = await call<{ code: string; siteName: string; inside: boolean; serverTime: string }>(hasan,
      "select public.prosm_time_connect_photo_proof(30.0183, 31.7446, 6) as r");
    expect(proof.code).toMatch(/^PT-[0-9A-F]{4}-[0-9A-F]{2}$/);
    expect(proof.siteName).toBe("Capital");
    expect(proof.inside).toBe(true);
    const sha = "a".repeat(64);
    expect(await call<boolean>(hasan, "select public.prosm_time_connect_photo_sealed($1, $2) as r", [proof.code, sha])).toBe(true);
    expect(await call<boolean>(mona, "select public.prosm_time_connect_photo_sealed($1, $2) as r", [proof.code, "b".repeat(64)])).toBe(false);
    const checked = await call<{ sha256: string; name: string }>(omar, "select public.prosm_time_connect_verify_photo($1) as r", [proof.code]);
    expect(checked).toMatchObject({ sha256: sha, name: "Hasan" });
    const far = await call<{ inside: boolean }>(hasan, "select public.prosm_time_connect_photo_proof(30.2, 31.9, 6) as r");
    expect(far.inside).toBe(false);
  });
});
