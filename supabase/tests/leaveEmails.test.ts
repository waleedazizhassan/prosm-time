// v2.3.54 (owner 2026-10-26): a leave request emails the reviewer with every
// detail; the decision emails the requester (approved: the dates and what is
// left of the balance) with a copy to whoever decided. Migration 20261026130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let employee: TestMember;
let requestId: string;

type LeaveEmail = {
  kind: string;
  recipient: { id: string; email: string };
  requester: { id: string; email: string; name: string };
  reviewer: { id: string; email: string } | null;
  leave: { type: string; startDate: string; endDate: string; days: number; reason: string | null; notes: string | null };
  remainingDays: number | null;
} | null;

const emailFor = async (notificationId: string) => (await t.su<{ e: LeaveEmail }>("select public.get_prosm_time_leave_email($1) as e", [notificationId]))[0].e;
const notesFor = (member: TestMember) =>
  t.su<{ id: string; type: string }>("select id, type from notifications where user_id = $1 and related_entity_id = $2 order by created_at", [member.userId, requestId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Mail Co");
  const site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Mona Manager");
  employee = await addMember(t, org, "employee", "Omar Employee");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await assignToSite(t, site, employee);
  await t.su("update leave_types set annual_days = 21 where organization_id = $1 and key = 'annual'", [org.id]);
  const result = await t.as(employee.authId, "select public.request_prosm_time_leave('annual', current_date + 40, current_date + 42, 'Family trip')");
  expect(result.error).toBeNull();
  [{ id: requestId }] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1", [employee.userId]);
});

describe("leave emails", () => {
  it("the request reaches the reviewer with every detail and the requester's email", async () => {
    const [note] = await notesFor(manager);
    const email = await emailFor(note.id);
    expect(email?.kind).toBe("request");
    expect(email?.recipient.id).toBe(manager.userId);
    expect(email?.requester).toMatchObject({ id: employee.userId, name: "Omar Employee" });
    expect(email?.requester.email).toContain("@");
    expect(email?.leave).toMatchObject({ type: "annual", days: 3, reason: "Family trip" });
  });

  it("the approval reaches the requester with the reviewer and the remaining balance", async () => {
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', 'Enjoy')", [requestId])).error).toBeNull();
    const notes = await notesFor(employee);
    const decision = notes.find((note) => note.type === "correction_reviewed")!;
    const email = await emailFor(decision.id);
    expect(email?.kind).toBe("approved");
    expect(email?.recipient.id).toBe(employee.userId);
    expect(email?.reviewer?.id).toBe(manager.userId);
    expect(email?.leave.notes).toBe("Enjoy");
    expect(Number(email?.remainingDays)).toBe(18);
  });

  it("other notifications send no email, and only the service role may read it", async () => {
    const [other] = await t.su<{ id: string }>(
      "insert into notifications (organization_id, user_id, type, priority, title, body) values ($1, $2, 'sos_alert', 'high', 'x', 'y') returning id",
      [org.id, employee.userId],
    );
    expect(await emailFor(other.id)).toBeNull();
    const [note] = await notesFor(manager);
    expect((await t.as(manager.authId, "select public.get_prosm_time_leave_email($1)", [note.id])).error).toMatch(/permission denied/);
  });
});

// v2.3.55 (owner 2026-10-27): the requester chooses who receives the request;
// a leave taken back after approval is "cancelled". Migration 20261027120000.
describe("choosing the reviewer", () => {
  it("lists the people who may approve, and sends the request only to the one chosen", async () => {
    const list = await t.as<{ r: { id: string; isOwner: boolean }[] }>(employee.authId, "select public.list_prosm_time_leave_reviewers() as r");
    const ids = list.rows![0].r.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([manager.userId, org.owner.userId]));
    expect(ids).not.toContain(employee.userId);

    const result = await t.as(employee.authId, "select public.request_prosm_time_leave('annual', current_date + 80, current_date + 80, 'Chosen', null, $1)", [org.owner.userId]);
    expect(result.error).toBeNull();
    const [row] = await t.su<{ id: string; requested_reviewer_id: string }>("select id, requested_reviewer_id from leave_requests where reason = 'Chosen'");
    expect(row.requested_reviewer_id).toBe(org.owner.userId);
    const told = await t.su<{ user_id: string }>("select user_id from notifications where related_entity_id = $1", [row.id]);
    expect(told.map((note) => note.user_id)).toEqual([org.owner.userId]);
    const [note] = await t.su<{ id: string }>("select id from notifications where related_entity_id = $1", [row.id]);
    expect((await emailFor(note.id) as unknown as { copyToRequester: boolean }).copyToRequester).toBe(true);
  });

  it("refuses someone who cannot approve the requester's leave", async () => {
    const other = await addMember(t, org, "employee", "Not A Reviewer");
    const result = await t.as(employee.authId, "select public.request_prosm_time_leave('annual', current_date + 90, current_date + 90, 'Wrong', null, $1)", [other.userId]);
    expect(result.error).toMatch(/CHOOSE SOMEONE WHO CAN APPROVE/);
  });

  it("taking back an approved leave is notified and emailed as cancelled", async () => {
    const [row] = await t.su<{ id: string }>("select id from leave_requests where reason = 'Chosen'");
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [row.id])).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'rejected', 'Plans changed')", [row.id])).error).toBeNull();
    const [last] = await t.su<{ id: string; action: string }>(
      "select id, data ->> 'actionType' as action from notifications where related_entity_id = $1 and type = 'correction_reviewed' order by created_at desc limit 1",
      [row.id],
    );
    expect(last.action).toBe("cancelled");
    expect((await emailFor(last.id))?.kind).toBe("cancelled");
  });
});
