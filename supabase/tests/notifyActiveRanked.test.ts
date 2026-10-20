// Workflow audit I4, owner 2026-10-20: a site notice reaches active people
// ranked above the person it is about - never that person - and every
// manager of the site for an SOS. Migration 20261020220000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let managerA: TestMember;
let peerA: TestMember;
let formerA: TestMember;

async function siteManager(name: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, member.userId]);
  return member;
}
async function noticeAbout(member: TestMember, type: string): Promise<string> {
  const [shift] = await t.su<{ id: string }>(
    "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - interval '2 hours', now() - interval '1 hour') returning id",
    [org.id, member.userId, siteA],
  );
  await t.su("select public.notify_prosm_time_site_managers_or_owner($1, $2, $3, 'high', 'Notice', 'Body', 'attendance_sessions', $4)", [org.id, siteA, type, shift.id]);
  return shift.id;
}
const told = async (member: TestMember, id: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and related_entity_id = $2", [member.userId, id]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  managerA = await siteManager("Manager A");
  peerA = await siteManager("Peer A");
  formerA = await siteManager("Former A");
  await t.su("update users set is_active = false where id = $1", [formerA.userId]);
});

describe("site notices", () => {
  it("tells neither the manager it is about, nor a peer, nor a deactivated account", async () => {
    const id = await noticeAbout(managerA, "out_of_zone_manager");
    expect(await told(managerA, id)).toBe(0);
    expect(await told(peerA, id)).toBe(0);
    expect(await told(formerA, id)).toBe(0);
    expect(await told(org.owner, id)).toBe(1);
  });

  it("brings every active manager of the site for an SOS", async () => {
    const id = await noticeAbout(managerA, "sos_alert");
    expect(await told(managerA, id)).toBe(0);
    expect(await told(peerA, id)).toBe(1);
    expect(await told(formerA, id)).toBe(0);
  });
});
