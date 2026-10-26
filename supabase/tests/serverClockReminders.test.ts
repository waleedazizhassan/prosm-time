// v2.3.48 (owner 2026-10-26: the clock-in reminder only showed when the app
// was opened): the server sends the reminders as push notifications - once,
// in the site's time zone, not when already clocked in or on leave, and
// never to the Owner. Migration 20261026110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let starting: TestMember;
let alreadyIn: TestMember;
let onLeave: TestMember;
let late: TestMember;

const tz = "public.prosm_time_site_timezone($2, $1)";
const shiftAt = (member: TestMember, minutesFromNow: number, endMinutesFromNow: number) =>
  t.su(
    `insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time)
     values ($1, $3, $2, ((now() + make_interval(mins => $4)) at time zone ${tz})::date,
             ((now() + make_interval(mins => $4)) at time zone ${tz})::time(0),
             ((now() + make_interval(mins => $5)) at time zone ${tz})::time(0))`,
    [org.id, site, member.userId, minutesFromNow, endMinutesFromNow],
  );
const reminders = async (member: TestMember, type: string) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = $2", [member.userId, type]))[0].n;
const run = () => t.su("select public.process_prosm_time_clock_reminders()");

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Reminder Co");
  site = await createSite(t, org, "Main");
  starting = await addMember(t, org, "employee", "Starting Soon");
  alreadyIn = await addMember(t, org, "employee", "Already In");
  onLeave = await addMember(t, org, "employee", "On Leave");
  late = await addMember(t, org, "employee", "Still Here");
  for (const member of [starting, alreadyIn, onLeave, late]) await assignToSite(t, site, member);

  await shiftAt(starting, 3, 480);
  await shiftAt(alreadyIn, 3, 480);
  await shiftAt(onLeave, 3, 480);
  await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - interval '10 minutes')", [org.id, alreadyIn.userId, site]);
  await t.su(
    `insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status)
     values ($1, $2, 'annual', (now() at time zone public.prosm_time_site_timezone(null, $1))::date, (now() at time zone public.prosm_time_site_timezone(null, $1))::date, 1, 'approved')`,
    [org.id, onLeave.userId],
  );
  // still clocked in 20 minutes after a shift that ended
  await shiftAt(late, -540, -20);
  await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - interval '9 hours')", [org.id, late.userId, site]);
});

describe("server clock reminders", () => {
  it("reminds to clock in just before a shift, once", async () => {
    await run();
    await run();
    expect(await reminders(starting, "clock_in_reminder")).toBe(1);
  });

  it("does not remind someone already clocked in or on approved leave", async () => {
    expect(await reminders(alreadyIn, "clock_in_reminder")).toBe(0);
    expect(await reminders(onLeave, "clock_in_reminder")).toBe(0);
  });

  it("reminds to clock out after the shift ended, once", async () => {
    await run();
    expect(await reminders(late, "clock_out_reminder")).toBe(1);
    expect(await reminders(late, "clock_in_reminder")).toBe(0);
  });

  it("never reminds the Owner", async () => {
    await shiftAt(org.owner, 3, 480);
    await run();
    expect(await reminders(org.owner, "clock_in_reminder")).toBe(0);
  });
});
