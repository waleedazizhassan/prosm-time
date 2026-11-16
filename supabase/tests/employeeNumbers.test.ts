// Employee codes (owner 2026-11-16), migration 20261116170000: 5 sequential digits per organisation, given the moment
// a person has a hiring date, by seniority when the owner numbers again; the payroll profile follows; never typed by
// hand; organisations number independently.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let late: TestMember;
let early: TestMember;
let noDate: TestMember;

const code = async (m: TestMember) => (await t.su<{ c: string | null }>("select employee_number as c from users where id = $1", [m.userId]))[0].c;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Codes");
  other = await createOrg(t, "OtherCodes");
  late = await addMember(t, org, "employee", "Late");
  early = await addMember(t, org, "employee", "Early");
  noDate = await addMember(t, org, "employee", "NoDate");
});

describe("a hiring date gives the code", () => {
  it("no hiring date, no code; the next number when a date is entered", async () => {
    expect(await code(late)).toBeNull();
    await t.su("update users set hire_date = '2024-05-01' where id = $1", [late.userId]);
    await t.su("update users set hire_date = '2019-01-10' where id = $1", [early.userId]);
    expect(await code(late)).toBe("00001");
    expect(await code(early)).toBe("00002");
    expect(await code(noDate)).toBeNull();
  });

  it("another organisation numbers on its own", async () => {
    const o = await addMember(t, other, "employee", "Elsewhere");
    await t.su("update users set hire_date = '2020-01-01' where id = $1", [o.userId]);
    expect(await code(o)).toBe("00001");
  });

  it("the owner numbers everyone again by seniority (earliest first), audited; nobody else can", async () => {
    expect((await t.as(late.authId, "select public.renumber_prosm_time_employee_codes()")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
    expect((await t.as(org.owner.authId, "select public.renumber_prosm_time_employee_codes()")).error).toBeNull();
    expect(await code(early)).toBe("00001");
    expect(await code(late)).toBe("00002");
    expect(await code(noDate)).toBeNull();
    expect((await t.su("select 1 from audit_logs where action = 'EMPLOYEE_CODES_RENUMBERED' and organization_id = $1", [org.id])).length).toBe(1);
  });

  it("the payroll profile shows the person's code - a typed code is not kept", async () => {
    await t.su("insert into payroll_profiles (organization_id, user_id, employee_code, currency) values ($1, $2, 'TYPED-99', 'EGP') on conflict (user_id) do update set employee_code = 'TYPED-99'", [org.id, early.userId]);
    const [{ c }] = await t.su<{ c: string }>("select employee_code as c from payroll_profiles where user_id = $1", [early.userId]);
    expect(c).toBe("00001");
    await t.as(org.owner.authId, "select public.renumber_prosm_time_employee_codes()");
    await t.su("update users set hire_date = '2018-01-01' where id = $1", [late.userId]);
    await t.as(org.owner.authId, "select public.renumber_prosm_time_employee_codes()");
    const [{ c: after }] = await t.su<{ c: string }>("select employee_code as c from payroll_profiles where user_id = $1", [early.userId]);
    expect(after).toBe("00002");
  });
});
