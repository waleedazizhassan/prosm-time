// v2.3.55 (owner 2026-10-27): the licence is the Owner's to see; no more
// active people than it allows; reminders a month and a week before a paid
// licence ends. Migration 20261027150000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Licence Co");
  manager = await addMember(t, org, "manager", "Mona");
});

describe("the licence is the Owner's", () => {
  it("only the Owner reads the licence row, its number and the seat count", async () => {
    expect((await t.as<{ n: number }>(org.owner.authId, "select count(*)::int as n from license_activation_state")).rows![0].n).toBe(1);
    expect((await t.as<{ n: number }>(manager.authId, "select count(*)::int as n from license_activation_state")).rows![0].n).toBe(0);

    const ownerTrial = await t.as<{ s: { licenseNumber: string | null } }>(org.owner.authId, "select public.get_prosm_time_trial_status() as s");
    const managerTrial = await t.as<{ s: { licenseNumber: string | null } }>(manager.authId, "select public.get_prosm_time_trial_status() as s");
    expect(ownerTrial.rows![0].s.licenseNumber).toBeTruthy();
    expect(managerTrial.rows![0].s.licenseNumber).toBeNull();

    expect((await t.as(manager.authId, "select public.get_prosm_time_seat_usage()")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.get_prosm_time_seat_usage()")).error).toBeNull();
  });
});

describe("licensed users", () => {
  it("refuses a person beyond the licence, and a reactivation too", async () => {
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from users where organization_id = $1 and is_active", [org.id]);
    await t.su("update license_activation_state set max_users = $2 where organization_id = $1", [org.id, n + 1]);
    const last = await addMember(t, org, "employee", "Last place");
    await expect(addMember(t, org, "employee", "One too many")).rejects.toThrow(/LICENSED USER LIMIT REACHED/);

    // someone leaves: a place frees; bringing them back when full is refused
    await t.su("update users set is_active = false where id = $1", [last.userId]);
    const replacement = await addMember(t, org, "employee", "Replacement");
    expect(replacement.userId).toBeTruthy();
    await expect(t.su("update users set is_active = true where id = $1", [last.userId])).rejects.toThrow(/LICENSED USER LIMIT REACHED/);
  });

  it("a licence without a limit refuses nobody", async () => {
    await t.su("update license_activation_state set max_users = null where organization_id = $1", [org.id]);
    expect((await addMember(t, org, "employee", "Unlimited")).userId).toBeTruthy();
  });
});

describe("reminders before a paid licence ends", () => {
  const claim = () => t.su<{ kind: string }>("select kind from public.claim_prosm_time_trial_notices() where organization_id = $1", [org.id]);

  it("a month before, once; a week before, once; a renewal reminds again", async () => {
    await t.su("update license_activation_state set is_trial = false, expires_at = now() + interval '20 days' where organization_id = $1", [org.id]);
    expect((await claim()).map((row) => row.kind)).toEqual(["LICENSE_MONTH"]);
    expect(await claim()).toEqual([]);

    await t.su("update license_activation_state set expires_at = now() + interval '5 days' where organization_id = $1", [org.id]);
    expect((await claim()).map((row) => row.kind)).toEqual(["LICENSE_WEEK"]);
    expect(await claim()).toEqual([]);

    const [note] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'license_ending'", [org.owner.userId]);
    expect(note.n).toBe(2);
  });
});
