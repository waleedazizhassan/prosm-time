// Owner 2026-11-16, migration 20261117200000: a licence ending - the first reminder a month before, then one every
// week until the end (and the day before); a renewal starts over.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { createOrg, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
const claim = async () => (await t.su<{ kind: string; organization_id: string }>("select * from public.claim_prosm_time_trial_notices()")).filter((r) => r.organization_id === org.id).map((r) => r.kind);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "LicWeek");
  await t.su("insert into license_activation_state (organization_id, license_number, status, is_trial, expires_at) values ($1, 'LIC-1', 'ACTIVE', false, now() + interval '25 days') on conflict (organization_id) do update set license_number = 'LIC-1', status = 'ACTIVE', is_trial = false, expires_at = now() + interval '25 days', license_month_notice_for = null, license_week_notice_for = null, license_day_notice_for = null", [org.id]);
});

describe("licence reminders", () => {
  it("the first within the month, nothing again the same week, then again a week later", async () => {
    expect(await claim()).toEqual(["LICENSE_MONTH"]);
    expect(await claim()).toEqual([]);
    await t.su("update license_activation_state set license_notice_last_at = now() - interval '8 days' where organization_id = $1", [org.id]);
    expect(await claim()).toEqual(["LICENSE_WEEK"]);
    expect(await claim()).toEqual([]);
  });
  it("the day before, once", async () => {
    await t.su("update license_activation_state set expires_at = now() + interval '20 hours' where organization_id = $1", [org.id]);
    expect(await claim()).toEqual(["LICENSE_DAY"]);
    expect(await claim()).toEqual([]);
  });
});
