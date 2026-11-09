// Owner 2026-11-08: leave counts working days only (migration 20261108110000).
// 2027-05-06 is a Thursday; the organisation rests on Friday (5) and Saturday (6).
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;
let manager: TestMember;

const request = (from: string, to: string, type = "annual") =>
  t.as<{ r: { requestId: string; daysCount: number } }>(worker.authId, "select public.request_prosm_time_leave($1, $2, $3, 'reason') as r", [type, from, to]);
const days = async (id: string) => Number((await t.su<{ d: string }>("select days_count as d from leave_requests where id = $1", [id]))[0].d);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Calendar Co");
  site = await createSite(t, org, "Works");
  worker = await addMember(t, org, "employee", "Worker");
  manager = await addMember(t, org, "manager", "Manager");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("update organization_settings set rest_days = array[5, 6]::smallint[] where organization_id = $1", [org.id]);
  await t.su("insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'Spring Day', '2027-05-10', '2027-05-10')", [org.id]);
});

describe("leave counts working days", () => {
  it("previews what a request takes before it is sent", async () => {
    const preview = await t.as<{ p: { workingDays: number; offDays: { date: string; type: string }[]; accepted: boolean } }>(
      worker.authId, "select public.preview_prosm_time_leave('annual', '2027-05-06', '2027-05-09') as p");
    expect(preview.error).toBeNull();
    expect(preview.rows![0].p.workingDays).toBe(2);
    expect(preview.rows![0].p.offDays.map((day) => day.type)).toEqual(["weekly_rest", "weekly_rest"]);
    expect(preview.rows![0].p.accepted).toBe(true);
  });

  it("accepts Thursday to Sunday whole and takes only Thursday and Sunday", async () => {
    const result = await request("2027-05-06", "2027-05-09");
    expect(result.error).toBeNull();
    expect(await days(result.rows![0].r.requestId)).toBe(2);
  });

  it("does not take a public holiday inside the range", async () => {
    const result = await request("2027-05-16", "2027-05-18");
    expect(result.error).toBeNull();
    expect(await days(result.rows![0].r.requestId)).toBe(3);
    const holiday = await request("2027-05-09", "2027-05-11");
    // overlaps the Thursday-Sunday request on the 9th, so try the week after the holiday rule alone
    expect(holiday.error).toMatch(/OVERLAPPING/);
    await t.su("insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'Second Day', '2027-05-24', '2027-05-24')", [org.id]);
    const withHoliday = await request("2027-05-23", "2027-05-25");
    expect(withHoliday.error).toBeNull();
    expect(await days(withHoliday.rows![0].r.requestId)).toBe(2);
  });

  it("refuses a request whose days are all rest days or holidays, saying which", async () => {
    expect((await request("2027-05-07", "2027-05-07")).error).toMatch(/NO WORKING DAY: 2027-05-07 weekly_rest/);
    expect((await request("2027-05-10", "2027-05-10")).error).toMatch(/public_holiday \(Spring Day\)/);
  });

  it("checks the balance on working days, and again when the leave is approved", async () => {
    await t.su("update leave_types set enforce_balance = true where organization_id = $1 and key = 'annual'", [org.id]);
    await t.su("insert into leave_entitlements (organization_id, user_id, leave_type, year, entitled_days) values ($1, $2, 'annual', 2027, 9) on conflict do nothing", [org.id, worker.userId]);
    await t.su("update leave_entitlements set entitled_days = 9 where user_id = $1 and leave_type = 'annual' and year = 2027", [worker.userId]);
    // 2 + 3 + 2 = 7 used; a 2-working-day request (Thu + Sun) fits in 9
    const fits = await request("2027-06-03", "2027-06-06");
    expect(fits.error).toBeNull();
    expect((await request("2027-06-13", "2027-06-15")).error).toMatch(/NOT ENOUGH LEAVE BALANCE/);
    // the balance shrinks before the decision: approval re-checks it
    await t.su("update leave_entitlements set entitled_days = 1 where user_id = $1 and leave_type = 'annual' and year = 2027", [worker.userId]);
    const approve = await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [fits.rows![0].r.requestId]);
    expect(approve.error).toMatch(/NOT ENOUGH LEAVE BALANCE/);
    const still = await t.su<{ status: string }>("select status from leave_requests where id = $1", [fits.rows![0].r.requestId]);
    expect(still[0].status).toBe("pending");
  });

  it("recounts the working days at approval when the calendar changed", async () => {
    await t.su("update leave_types set enforce_balance = false where organization_id = $1 and key = 'annual'", [org.id]);
    const later = await request("2027-07-04", "2027-07-06");
    expect(await days(later.rows![0].r.requestId)).toBe(3);
    await t.su("insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'New Holiday', '2027-07-05', '2027-07-05')", [org.id]);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [later.rows![0].r.requestId])).error).toBeNull();
    expect(await days(later.rows![0].r.requestId)).toBe(2);
  });
});
