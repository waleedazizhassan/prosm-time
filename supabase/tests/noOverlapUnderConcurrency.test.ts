// QA-009 / QA-010 (2026-11-16) - on a real PostgreSQL two leave requests for the same day (5/5) and two payroll cycles
// for the same period (2/3) both went through when sent at the same moment: the rule was checked, then written.
// Migration 20261116120000 checks again at the moment of writing, under a per-person / per-organisation lock, on
// every path. The two-connection race itself ran on a real PostgreSQL (PGlite is one connection); here: the rule
// holds even for a direct write that skips the request function, and the old behaviours stay.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let emp: TestMember;
const insertLeave = (start: string, end: string, status = "pending") =>
  t.su("insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', $3, $4, 1, $5) returning id", [org.id, emp.userId, start, end, status]);
const insertCycle = (start: string, end: string, site: string | null = null, status = "draft") =>
  t.su("insert into payroll_cycles (organization_id, site_id, title, period_start, period_end, status, policy_snapshot) values ($1, $2, 'c', $3, $4, $5, '{}'::jsonb) returning id", [org.id, site, start, end, status]);
const fails = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "NoOverlap");
  emp = await addMember(t, org, "employee", "Nour");
});

describe("leave: one pending or approved request per day per person", () => {
  it("a second overlapping request is refused even when written directly", async () => {
    await insertLeave("2027-03-01", "2027-03-03");
    expect(await fails(insertLeave("2027-03-03", "2027-03-04"))).toMatch(/OVERLAPPING THESE DATES/);
    expect(await fails(insertLeave("2027-03-04", "2027-03-05"))).toBeNull();
  });
  it("rejected or cancelled requests do not block", async () => {
    await insertLeave("2027-04-01", "2027-04-01", "rejected");
    expect(await fails(insertLeave("2027-04-01", "2027-04-01"))).toBeNull();
  });
  it("of two overlapping requests made before the fix, one can be approved - not both", async () => {
    await t.su("alter table leave_requests disable trigger leave_requests_no_overlap");
    const [{ id: first }] = await insertLeave("2027-05-03", "2027-05-03");
    const [{ id: second }] = await insertLeave("2027-05-03", "2027-05-03");
    await t.su("alter table leave_requests enable trigger leave_requests_no_overlap");
    expect(await fails(t.su("update leave_requests set status = 'approved' where id = $1", [first]))).toBeNull();
    expect(await fails(t.su("update leave_requests set status = 'approved' where id = $1", [second]))).toMatch(/OVERLAPPING THESE DATES/);
  });
});

describe("payroll: one active cycle per period and scope", () => {
  it("a second overlapping cycle is refused even when written directly; cancelled cycles do not block", async () => {
    await insertCycle("2027-06-01", "2027-06-30");
    expect(await fails(insertCycle("2027-06-15", "2027-07-14"))).toMatch(/ALREADY COVERS THIS PERIOD AND SCOPE/);
    await insertCycle("2027-08-01", "2027-08-31", null, "cancelled");
    expect(await fails(insertCycle("2027-08-01", "2027-08-31"))).toBeNull();
  });
  it("reviving a cancelled cycle over an active one is refused", async () => {
    const [{ id }] = await insertCycle("2027-09-01", "2027-09-30", null, "cancelled");
    await insertCycle("2027-09-01", "2027-09-30");
    expect(await fails(t.su("update payroll_cycles set status = 'draft' where id = $1", [id]))).toMatch(/ALREADY COVERS/);
  });
});
