// v2.3.59 (owner 2026-10-28: "the leave request emails need a real review of
// the workflow"): a request withdrawn before an answer tells the person it
// was sent to; when someone else decides, that person is named for a copy;
// each reader's language is sent. Migration 20261028160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let employee: TestMember;

type LeaveEmail = {
  kind: string;
  copyToRequester: boolean;
  recipient: { id: string };
  reviewer: { id: string } | null;
  chosenReviewer: { id: string } | null;
  languages: Record<string, string>;
} | null;

const emailFor = async (notificationId: string) => (await t.su<{ e: LeaveEmail }>("select public.get_prosm_time_leave_email($1) as e", [notificationId]))[0].e;
const request = async (offset: number) => {
  const result = await t.as(employee.authId, "select public.request_prosm_time_leave('annual', current_date + $1::int, current_date + $1::int, null, null, $2)", [offset, manager.userId]);
  expect(result.error).toBeNull();
  const [row] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [employee.userId]);
  return row.id;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Flow Co");
  const site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Mona Manager");
  employee = await addMember(t, org, "employee", "Omar Employee");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await assignToSite(t, site, employee);
  await t.su("update leave_types set annual_days = 21 where organization_id = $1 and key = 'annual'", [org.id]);
});

describe("leave email workflow", () => {
  it("a request withdrawn before an answer tells the person it was sent to, by notification and email", async () => {
    const id = await request(40);
    expect((await t.as(employee.authId, "select public.cancel_prosm_time_leave_request($1)", [id])).error).toBeNull();
    const [note] = await t.su<{ id: string; data: { kind: string } }>(
      "select id, data from notifications where user_id = $1 and related_entity_id = $2 and data ->> 'kind' = 'leave_request_withdrawn'",
      [manager.userId, id],
    );
    expect(note).toBeDefined();
    const email = await emailFor(note.id);
    expect(email).toMatchObject({ kind: "request_withdrawn", copyToRequester: true, recipient: { id: manager.userId } });
  });

  it("when the owner decides a request sent to a manager, the manager is named for a copy; each reader has a language", async () => {
    const id = await request(50);
    await t.su("insert into push_devices (organization_id, user_id, token, platform, language) values ($2, $1, 'token-mona-0123456789', 'android', 'en')", [manager.userId, org.id]);
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [id])).error).toBeNull();
    const [note] = await t.su<{ id: string }>("select id from notifications where user_id = $1 and related_entity_id = $2 and type = 'correction_reviewed'", [employee.userId, id]);
    const email = await emailFor(note.id);
    expect(email?.kind).toBe("approved");
    expect(email?.reviewer?.id).toBe(org.owner.userId);
    expect(email?.chosenReviewer?.id).toBe(manager.userId);
    expect(email?.languages[manager.userId]).toBe("en");
    expect(email?.languages[employee.userId]).toBe("ar");
  });

  it("the person it was sent to deciding it is not named twice", async () => {
    const id = await request(60);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'rejected', null)", [id])).error).toBeNull();
    const [note] = await t.su<{ id: string }>("select id from notifications where user_id = $1 and related_entity_id = $2 and type = 'correction_reviewed'", [employee.userId, id]);
    expect((await emailFor(note.id))?.chosenReviewer).toBeNull();
  });
});
