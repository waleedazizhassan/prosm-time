// v2.3.43 step 7 (item 25): leave types are settings seeded from Law 14/2025
// (press reports): annual tiers by years of service, casual 7/year at most 2
// at a time, a document for sick leave, once-in-service and service-year
// rules; existing balances are not recalculated. Migration 20261025160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let newcomer: TestMember;
let veteran: TestMember;
let manager: TestMember;

type Balance = { leaveType: string; entitledDays: number | null; computedDays: number | null; setDays: number | null; differs: boolean; remainingDays: number | null };
async function balance(member: TestMember, type: string, year = 2027) {
  const result = await t.as<{ b: { balances: Balance[] } }>(member.authId, "select public.get_prosm_time_leave_balance(null, $1) as b", [year]);
  expect(result.error).toBeNull();
  return result.rows![0].b.balances.find((row) => row.leaveType === type)!;
}
const request = (member: TestMember, type: string, from: string, to: string, doc: string | null = null) =>
  t.as(member.authId, "select public.request_prosm_time_leave($1, $2, $3, 'reason', $4)", [type, from, to, doc]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Qena");
  site = await createSite(t, org, "Farm");
  newcomer = await addMember(t, org, "employee", "New Comer");
  veteran = await addMember(t, org, "employee", "Old Hand");
  manager = await addMember(t, org, "manager", "Farm Manager");
  for (const member of [newcomer, veteran]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("update users set hire_date = '2026-09-01' where id = $1", [newcomer.userId]);
  await t.su("update users set hire_date = '2014-01-01' where id = $1", [veteran.userId]);
});

describe("leave types (item 25)", () => {
  it("every organisation gets the starting set, a new one too", async () => {
    const keys = (await t.su<{ key: string }>("select key from leave_types where organization_id = $1 order by sort_order", [org.id])).map((row) => row.key);
    expect(keys).toEqual(["annual", "emergency", "sick", "unpaid", "hajj", "bereavement", "paternity", "other"]);
    const other = await createOrg(t, "Fresh");
    expect(await t.su("select id from leave_types where organization_id = $1", [other.id])).toHaveLength(8);
  });

  it("annual days follow the years of service: 15 in the first year, 30 after 10 years, 45 with special needs", async () => {
    expect((await balance(newcomer, "annual", 2027)).entitledDays).toBe(15);
    expect((await balance(newcomer, "annual", 2028)).entitledDays).toBe(21);
    expect((await balance(veteran, "annual", 2027)).entitledDays).toBe(30);
    await t.su("update users set special_needs_entitlement = true where id = $1", [veteran.userId]);
    expect((await balance(veteran, "annual", 2027)).entitledDays).toBe(45);
  });

  it("a balance already set is kept; the difference is shown", async () => {
    await t.su("insert into leave_entitlements (organization_id, user_id, leave_type, year, entitled_days) values ($1, $2, 'annual', 2027, 21)", [org.id, newcomer.userId]);
    const row = await balance(newcomer, "annual", 2027);
    expect(row.entitledDays).toBe(21);
    expect(row.computedDays).toBe(15);
    expect(row.differs).toBe(true);
  });

  it("casual leave: at most 2 days at a time and 7 a year", async () => {
    expect((await request(newcomer, "emergency", "2027-02-01", "2027-02-03")).error).toMatch(/AT MOST 2 DAYS AT A TIME/);
    for (const day of ["01", "08", "15"]) expect((await request(newcomer, "emergency", `2027-03-${day}`, `2027-03-${String(Number(day) + 1).padStart(2, "0")}`)).error).toBeNull();
    expect((await request(newcomer, "emergency", "2027-04-01", "2027-04-02")).error).toMatch(/NOT ENOUGH LEAVE BALANCE/);
    expect((await request(newcomer, "emergency", "2027-04-01", "2027-04-01")).error).toBeNull();
    expect((await balance(newcomer, "emergency", 2027)).remainingDays).toBe(0);
  });

  it("sick leave needs a document in the person's own folder", async () => {
    expect((await request(veteran, "sick", "2027-05-01", "2027-05-02")).error).toMatch(/NEEDS A DOCUMENT/);
    expect((await request(veteran, "sick", "2027-05-01", "2027-05-02", `${org.id}/${newcomer.userId}/report.pdf`)).error).toMatch(/INVALID DOCUMENT/);
    expect((await request(veteran, "sick", "2027-05-01", "2027-05-02", `${org.id}/${veteran.userId}/report.pdf`)).error).toBeNull();
  });

  it("hajj needs 5 years of service and is once in the service", async () => {
    expect((await request(newcomer, "hajj", "2027-06-01", "2027-06-20")).error).toMatch(/5 YEARS OF SERVICE/);
    expect((await request(veteran, "hajj", "2027-06-01", "2027-06-20")).error).toBeNull();
    expect((await request(veteran, "hajj", "2028-06-01", "2028-06-10")).error).toMatch(/AT MOST 1 TIMES/);
  });

  it("only the Owner manages the types; changes are audited; an unknown type is refused", async () => {
    expect((await t.as(manager.authId, "select public.save_prosm_time_leave_type(null, 'study', '{\"name\":\"Study\"}'::jsonb)")).error).toMatch(/MANAGE_TYPES/);
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_leave_type(null, 'study', '{\"name\":\"Study\",\"annualDays\":5,\"isPaid\":false}'::jsonb)")).error).toBeNull();
    expect((await request(newcomer, "study", "2027-07-01", "2027-07-02")).error).toBeNull();
    expect((await request(newcomer, "nonsense", "2027-07-05", "2027-07-05")).error).toMatch(/INVALID LEAVE TYPE/);
    expect(await t.su("select id from audit_logs where action = 'leave.type_saved'")).toHaveLength(1);
  });

  it("the hire date is set by the Owner or an authorised manager, never in the future", async () => {
    expect((await t.as(newcomer.authId, "select public.set_prosm_time_employment_details($1, '2020-01-01', false)", [newcomer.userId])).error).toMatch(/EMPLOYEES.EDIT/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_employment_details($1, '2099-01-01', false)", [newcomer.userId])).error).toMatch(/FUTURE/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_employment_details($1, '2020-01-01', false)", [newcomer.userId])).error).toBeNull();
  });
});
