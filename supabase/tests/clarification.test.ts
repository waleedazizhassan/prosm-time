// Owner 2026-10-20: "request clarification" sends the exception back to the
// employee with the manager's question, and they can answer it. Migration
// 20261020150000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let employee: TestMember;
let exceptionId: string;

const status = async () => (await t.su<{ status: string; clarification_request: string | null }>("select status, clarification_request from geofence_exceptions where id = $1", [exceptionId]))[0];
const review = (kind: string, id: string, action: string, notes: string | null = null) =>
  t.as(org.owner.authId, "select public.review_prosm_time_exception($1, $2, $3, $4)", [kind, id, action, notes]);
const answer = (text: string) => t.as(employee.authId, "select public.submit_prosm_time_exception_reason($1, 'work_assignment', $2)", [exceptionId, text]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, siteId, employee);
  expect((await clockIn(t, employee, siteId)).error).toBeNull();
  const [event] = await t.su<{ id: string }>("select id from attendance_events where user_id = $1 and event_type = 'clock_in'", [employee.userId]);
  const [exception] = await t.su<{ id: string }>(
    "insert into geofence_exceptions (organization_id, user_id, attendance_event_id, status, distance_meters) values ($1, $2, $3, 'pending_reason', 400) returning id",
    [org.id, employee.userId, event.id],
  );
  exceptionId = exception.id;
});

describe("request clarification", () => {
  it("sends the exception back to the employee with the question, and their new answer comes back for review", async () => {
    expect((await answer("Out for a delivery")).error).toBeNull();
    expect((await review("geofence_exception", exceptionId, "clarification_requested", "Which supplier?")).error).toBeNull();
    expect(await status()).toEqual({ status: "pending_reason", clarification_request: "Which supplier?" });
    expect((await answer("Delta Steel, for the rebar order")).error).toBeNull();
    expect((await status()).status).toBe("pending_review");
  });

  it("is refused for items the person can't answer", async () => {
    expect((await review("correction_request", exceptionId, "clarification_requested")).error).toMatch(/INVALID ACTION TYPE FOR THIS ITEM/);
  });
});
