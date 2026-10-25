// v2.3.43 step 11 (item 22): live capture, one-time tokens, the liveness
// challenge (OFF / RANDOM / ALWAYS, escalation after two failures,
// exemption) and coordinate checks - every result recorded, nothing
// blocks, flags reach the review queue. Migration 20261025200000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;
let manager: TestMember;

type Token = { token: string; challengeRequired: boolean; challenge: string | null; escalated: boolean };
const issue = async (member: TestMember) => (await t.as<{ r: Token }>(member.authId, "select public.issue_prosm_time_capture_token($1) as r", [site])).rows![0].r;

// A clock-in with evidence, then the integrity record.
async function checkIn(token: string | null, source: string, result: string) {
  const res = await clockIn(t, worker, site);
  expect(res.error).toBeNull();
  const eventId = (res.rows![0] as { r: { eventId: string } }).r.eventId;
  await t.su(
    "insert into camera_evidence (organization_id, attendance_event_id, user_id, storage_path, content_type) values ($1, $2, $3, $4, 'image/jpeg')",
    [org.id, eventId, worker.userId, `attendance-events/${eventId}/${randomUUID()}.jpg`],
  );
  const rec = await t.as<{ r: { flags: string[]; livenessResult: string } }>(
    worker.authId,
    "select public.record_prosm_time_capture_integrity($1, $2, $3, $4, null, 0.9) as r",
    [eventId, token, source, result],
  );
  expect(rec.error).toBeNull();
  expect((await clockOut(t, worker)).error).toBeNull();
  return { eventId, ...rec.rows![0].r };
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Damietta");
  site = await createSite(t, org, "Factory");
  worker = await addMember(t, org, "employee", "Yara Fouad");
  manager = await addMember(t, org, "manager", "Factory Manager");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
});

describe("capture integrity (item 22)", () => {
  it("OFF by default: no challenge; a live photo with a fresh token raises nothing", async () => {
    const token = await issue(worker);
    expect(token.challengeRequired).toBe(false);
    const result = await checkIn(token.token, "live_camera", "not_required");
    expect(result.flags).toEqual([]);
  });

  it("a used or old token, a missing token and a photo from a file are flagged - never blocked", async () => {
    const token = await issue(worker);
    expect((await checkIn(token.token, "live_camera", "not_required")).flags).toEqual([]);
    expect((await checkIn(token.token, "live_camera", "not_required")).flags).toEqual(["reused_token"]);
    const old = await issue(worker);
    await t.su("update capture_tokens set issued_at = now() - interval '10 minutes' where id = $1", [old.token]);
    expect((await checkIn(old.token, "live_camera", "not_required")).flags).toEqual(["stale_capture"]);
    expect((await checkIn(null, "file_fallback", "not_required")).flags).toEqual(["missing_token", "unverified_capture"]);
  });

  it("ALWAYS: every token asks a challenge; passed, failed and unavailable are recorded; a skipped one counts as failed", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_site_integrity($1, 'ALWAYS', null, null)", [site])).error).toMatch(/MANAGE_INTEGRITY/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_site_integrity($1, 'ALWAYS', null, null)", [site])).error).toBeNull();
    const a = await issue(worker);
    expect(a.challengeRequired).toBe(true);
    expect(["turn_left", "turn_right", "move_closer"]).toContain(a.challenge);
    expect((await checkIn(a.token, "live_camera", "passed")).flags).toEqual([]);
    expect((await checkIn((await issue(worker)).token, "live_camera", "unavailable")).flags).toEqual(["liveness_unavailable"]);
    const skipped = await checkIn((await issue(worker)).token, "live_camera", "not_required");
    expect(skipped.livenessResult).toBe("failed");
    const [evidence] = await t.su<{ liveness_result: string; capture_source: string }>("select liveness_result, capture_source from camera_evidence where attendance_event_id = $1", [skipped.eventId]);
    expect(evidence).toEqual({ liveness_result: "failed", capture_source: "live_camera" });
  });

  it("two failures in a day turn the challenge on for the rest of the day, even when the site is OFF", async () => {
    await t.as(org.owner.authId, "select public.set_prosm_time_site_integrity($1, 'OFF', null, null)", [site]);
    await checkIn((await issue(worker)).token, "live_camera", "failed");
    const after = await issue(worker);
    expect(after.challengeRequired).toBe(true);
    expect(after.escalated).toBe(true);
  });

  it("a manager exempts a person with a recorded reason (accessibility)", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_liveness_exemption($1, true, '')", [worker.userId])).error).toMatch(/REASON/);
    expect((await t.as(manager.authId, "select public.set_prosm_time_liveness_exemption($1, true, 'visual impairment')", [worker.userId])).error).toBeNull();
    expect((await issue(worker)).challengeRequired).toBe(false);
    await t.as(manager.authId, "select public.set_prosm_time_liveness_exemption($1, false, null)", [worker.userId]);
  });

  it("the same coordinates with ~zero accuracy and a perfect accuracy are flagged", async () => {
    const at = { latitude: 30.02125, longitude: 31.75812 };
    for (let i = 0; i < 2; i += 1) {
      expect((await t.as(worker.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, null, $3, $4, 0)", [randomUUID(), site, at.latitude, at.longitude])).error).toBeNull();
      expect((await clockOut(t, worker)).error).toBeNull();
    }
    const kinds = (await t.su<{ kind: string }>("select distinct kind from integrity_flags where user_id = $1", [worker.userId])).map((row) => row.kind);
    expect(kinds).toContain("suspicious_accuracy");
    expect(kinds).toContain("repeated_coordinates");
  });

  it("flags reach the manager's queue; a rejection needs a reason; it is audited and the employee told", async () => {
    const queue = await t.as<{ id: string; kind: string }>(manager.authId, "select * from public.list_prosm_time_integrity_flags('pending_review')");
    expect(queue.rows!.length).toBeGreaterThan(3);
    const id = queue.rows![0].id;
    expect((await t.as(manager.authId, "select public.review_prosm_time_integrity_flag($1, 'rejected', '')", [id])).error).toMatch(/REASON/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_integrity_flag($1, 'rejected', 'photo of a photo')", [id])).error).toBeNull();
    expect(await t.su("select id from audit_logs where action = 'attendance.integrity_rejected'")).toHaveLength(1);
    expect(await t.su("select id from notifications where user_id = $1 and related_entity_id = $2", [worker.userId, id])).toHaveLength(1);
  });
});
