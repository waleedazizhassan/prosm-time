// TURN bandwidth strategy (owner 2026-11-16), migration 20261116130000: the app's usage reports, the owner's report,
// one organisation never sees another's, and the platform-wide monthly relay totals and 50/75/90/95 % marks are for
// the connect-ice function (service role) only.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let a: TestOrg;
let b: TestOrg;
let worker: TestMember;
const RELAY = "global.relay.metered.ca";
let peerB: TestMember;
// SA-06 (2026-11-16): usage counts only for a call the reporter took part in - each report gets its own call
const report = async (who: TestMember, kind: string, route: string, server: string | null, bytes: number, seconds: number) => {
  const [{ org }] = await t.su<{ org: string }>("select organization_id as org from users where id = $1", [who.userId]);
  const [{ other }] = await t.su<{ other: string }>("select id as other from users where organization_id = $1 and id <> $2 limit 1", [org, who.userId]);
  const [{ id }] = await t.su<{ id: string }>("insert into connect_calls (organization_id, caller_id, callee_id, media) values ($1, $2, $3, 'audio') returning id", [org, who.userId, other]);
  return t.as(who.authId, "select public.record_prosm_time_connect_usage($1, $2, $3, $4, $5, $6)", [kind, id, route, server, bytes, seconds]);
};
const asService = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
  let rows: T[] = [];
  await t.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await tx.exec("set local role service_role");
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
};

beforeAll(async () => {
  t = await buildDatabase();
  a = await createOrg(t, "TurnA");
  b = await createOrg(t, "TurnB");
  worker = await addMember(t, a, "employee", "Wael");
  peerB = await addMember(t, b, "employee", "PeerB");
  expect((await report(worker, "video", "relay", RELAY, 6_000_000, 120)).error).toBeNull();
  expect((await report(a.owner, "audio", "srflx", "ignored.example", 900_000, 300)).error).toBeNull();
  expect((await report(b.owner, "meeting", "relay", RELAY, 4_000_000, 60)).error).toBeNull();
});

describe("reports from the app", () => {
  it("nonsense is refused; a direct route keeps no server name", async () => {
    expect((await report(worker, "video", "relay", RELAY, -1, 10)).error).toMatch(/INVALID USAGE/);
    expect((await report(worker, "fax", "relay", RELAY, 1, 1)).error).toMatch(/INVALID KIND/);
    expect((await report(worker, "audio", "carrier-pigeon", null, 1, 1)).error).toMatch(/INVALID ROUTE/);
    const rows = await t.su<{ server: string | null }>("select server from connect_turn_usage where route = 'srflx'");
    expect(rows.every((r) => r.server === null)).toBe(true);
  });
  it("nobody reads the usage table directly", async () => {
    expect((await t.as(a.owner.authId, "select * from connect_turn_usage")).error).toMatch(/permission denied/);
  });
});

describe("the owner's report", () => {
  it("per kind: relay vs direct minutes, bytes per minute, per relay server - own organisation only", async () => {
    const r = await t.as<{ r: { kinds: { kind: string; relayMinutes: number; directMinutes: number; bytesPerMinute: number }[]; servers: { server: string; bytes: number }[]; totalRelayBytes: number } }>(
      a.owner.authId, "select public.get_prosm_time_connect_usage_report() as r");
    expect(r.error).toBeNull();
    const rep = r.rows![0].r;
    expect(Number(rep.totalRelayBytes)).toBe(6_000_000); // not organisation B's 4 MB
    expect(rep.servers).toEqual([expect.objectContaining({ server: RELAY })]);
    expect(Number(rep.servers[0].bytes)).toBe(6_000_000);
    const video = rep.kinds.find((k) => k.kind === "video")!;
    expect(Number(video.relayMinutes)).toBe(2);
    expect(Number(video.directMinutes)).toBe(0);
    expect(Number(video.bytesPerMinute)).toBe(3_000_000);
    const audio = rep.kinds.find((k) => k.kind === "audio")!;
    expect(Number(audio.directMinutes)).toBe(5);
  });
  it("only the owner", async () => {
    expect((await t.as(worker.authId, "select public.get_prosm_time_connect_usage_report()")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
  });
});

describe("platform totals for connect-ice", () => {
  it("the month's relay total per server counts every organisation; the app cannot call it", async () => {
    const rows = await asService<{ server: string; used_bytes: number }>("select * from public.prosm_time_connect_relay_month($1)", [[RELAY, "other.example"]]);
    expect(Number(rows.find((r) => r.server === RELAY)!.used_bytes)).toBe(10_000_000);
    expect(Number(rows.find((r) => r.server === "other.example")!.used_bytes)).toBe(0);
    expect((await t.as(a.owner.authId, "select * from public.prosm_time_connect_relay_month(array['x'])")).error).toMatch(/permission denied/);
  });
  it("a level is marked once a month (the warning goes out once)", async () => {
    const first = await asService<{ v: boolean }>("select public.prosm_time_connect_mark_alert($1, 75, 1, 2) as v", [RELAY]);
    const again = await asService<{ v: boolean }>("select public.prosm_time_connect_mark_alert($1, 75, 1, 2) as v", [RELAY]);
    expect(first[0].v).toBe(true);
    expect(again[0].v).toBe(false);
  });
});
