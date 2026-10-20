// Security review L2/L3, owner 2026-10-20: a clock-in photo stays in its own
// folder; the logo and avatar must be this project's uploaded images.
// Migration 20261020210000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let employee: TestMember;
const STORAGE = "https://abc.supabase.co/storage/v1/object/public";

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const site = await createSite(t, org, "Site A");
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, site, employee);
  expect((await clockIn(t, employee, site)).error).toBeNull();
});

describe("stored paths and addresses", () => {
  it("keeps a clock-in photo inside its own clock-in folder", async () => {
    const [event] = await t.su<{ id: string }>("select id from attendance_events where user_id = $1 limit 1", [employee.userId]);
    const attach = (path: string) => t.as(employee.authId, "select public.attach_prosm_time_camera_evidence($1, $2, 'image/jpeg', 1000)", [event.id, path]);
    expect((await attach(`attendance-events/${crypto.randomUUID()}/x.jpg`)).error).toMatch(/OWN CLOCK-IN FOLDER/);
    expect((await attach(`attendance-events/${event.id}/../other.jpg`)).error).toMatch(/OWN CLOCK-IN FOLDER/);
    expect(String((await attach(`attendance-events/${event.id}/photo.jpg`)).error ?? "")).not.toMatch(/OWN CLOCK-IN FOLDER/);
  });

  it("accepts only an uploaded logo or avatar, or none", async () => {
    const logo = (url: string | null) => t.as(org.owner.authId, "select public.set_prosm_time_organization_logo($1)", [url]);
    expect((await logo("https://tracker.example/pixel.gif")).error).toMatch(/UPLOADED IMAGE/);
    expect((await logo(`${STORAGE}/organization-logos/x" onerror="alert(1).png`)).error).toMatch(/UPLOADED IMAGE/);
    expect((await logo(`${STORAGE}/organization-logos/org/logo.png`)).error).toBeNull();
    expect((await logo(null)).error).toBeNull();

    const avatar = (url: string) => t.as(employee.authId, "select public.set_prosm_time_own_avatar($1)", [url]);
    expect((await avatar(`${STORAGE}/organization-logos/org/logo.png`)).error).toMatch(/UPLOADED IMAGE/);
    expect((await avatar(`${STORAGE}/user-avatars/users/${employee.userId}/me.png`)).error).toBeNull();
  });
});
