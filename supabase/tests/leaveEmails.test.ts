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
