// v2.3.55 (owner 2026-10-27): devices count as those with an account open on
// them; a device new to the organisation is refused when the licence's devices
// are all in use. Migration 20261027180000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

const id = (name: string) => `device-${name}-0123456789abcdef`;

describe("licensed devices", () => {
  it("counts each device once, refuses a new one when full, and frees a place on sign-out", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Devices Co");
    const a = await addMember(t, org, "employee", "A");
    const b = await addMember(t, org, "employee", "B");
    await t.su("update license_activation_state set max_devices = 2 where organization_id = $1", [org.id]);
    const register = (member: typeof a, device: string) => t.as(member.authId, "select public.register_prosm_time_device($1, 'android', null)", [id(device)]);
    const usage = async () => (await t.as<{ s: { activeDevices: number; maxDevices: number } }>(org.owner.authId, "select public.get_prosm_time_seat_usage() as s")).rows![0].s;

    expect((await register(a, "phone-a")).error).toBeNull();
    expect((await register(a, "phone-a")).error).toBeNull(); // the same phone again
    expect((await register(b, "phone-a")).error).toBeNull(); // a shared phone counts once
    expect((await register(b, "phone-b")).error).toBeNull();
    expect(await usage()).toMatchObject({ activeDevices: 2, maxDevices: 2 });

    expect((await register(a, "laptop")).error).toMatch(/LICENSED DEVICE LIMIT REACHED/);
    // a known device keeps working when full
    expect((await register(a, "phone-a")).error).toBeNull();

    // phone-b signs out: its place frees
    expect((await t.as(b.authId, "select public.forget_prosm_time_device($1)", [id("phone-b")])).error).toBeNull();
    expect((await register(a, "laptop")).error).toBeNull();
  });

  // v2.3.59 (owner 2026-10-28): clearing the app's data gave his phone a new id each time. Migration 20261028130000.
  it("the same person's phone of the same model with a new id replaces the old one, it is not another device", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Phone Co");
    const a = await addMember(t, org, "employee", "A");
    const b = await addMember(t, org, "employee", "B");
    await t.su("update license_activation_state set max_devices = 2 where organization_id = $1", [org.id]);
    const register = (member: typeof a, device: string, platform: string, label: string | null) =>
      t.as(member.authId, "select public.register_prosm_time_device($1, $2, $3)", [id(device), platform, label]);
    const count = async () => (await t.su<{ n: number }>("select count(*)::int as n from signed_in_devices where organization_id = $1", [org.id]))[0].n;

    expect((await register(a, "first", "android", "Android - X1")).error).toBeNull();
    expect((await register(b, "other", "android", "Android - Z9")).error).toBeNull();
    // full - A's phone after its data was cleared still gets in, in its old place
    for (const fresh of ["second", "third", "fourth"]) expect((await register(a, fresh, "android", "Android - X1")).error).toBeNull();
    expect(await count()).toBe(2);
    // a different model, the web, or another person is a new device as before
    expect((await register(a, "tablet", "android", "Android - T5")).error).toMatch(/LICENSED DEVICE LIMIT REACHED/);
    expect((await register(a, "browser", "web", "Android - X1")).error).toMatch(/LICENSED DEVICE LIMIT REACHED/);
    expect((await register(b, "b-new", "android", "Android - X1")).error).toMatch(/LICENSED DEVICE LIMIT REACHED/);
  });

  it("a device unused for 30 days stops counting", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Old Co");
    const a = await addMember(t, org, "employee", "A");
    await t.su("update license_activation_state set max_devices = 1 where organization_id = $1", [org.id]);
    expect((await t.as(a.authId, "select public.register_prosm_time_device($1)", [id("old")])).error).toBeNull();
    await t.su("update signed_in_devices set last_seen_at = now() - interval '31 days'");
    expect((await t.as(a.authId, "select public.register_prosm_time_device($1)", [id("new")])).error).toBeNull();
  });
});

// v2.3.55 (owner 2026-10-27): the Owner lists the devices and removes one. Migration 20261027190000.
describe("the Owner's list of devices", () => {
  it("lists each device once with who used it, removes it to free its place, and is the Owner's only", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "List Co");
    const a = await addMember(t, org, "employee", "Alaa");
    const b = await addMember(t, org, "employee", "Basma");
    await t.su("update license_activation_state set max_devices = 1 where organization_id = $1", [org.id]);
    await t.as(a.authId, "select public.register_prosm_time_device($1, 'android', 'Android - V2529')", [id("shared")]);
    await t.as(b.authId, "select public.register_prosm_time_device($1, 'android', 'Android - V2529')", [id("shared")]);

    const list = await t.as<{ l: { deviceId: string; people: string[]; counted: boolean }[] }>(org.owner.authId, "select public.list_prosm_time_devices() as l");
    expect(list.rows![0].l).toHaveLength(1);
    expect(list.rows![0].l[0].people.sort()).toEqual(["Alaa", "Basma"]);
    expect(list.rows![0].l[0].counted).toBe(true);

    expect((await t.as(a.authId, "select public.list_prosm_time_devices()")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(a.authId, "select public.remove_prosm_time_device($1)", [id("shared")])).error).toMatch(/ONLY THE OWNER/);

    expect((await t.as(b.authId, "select public.register_prosm_time_device($1)", [id("another")])).error).toMatch(/LICENSED DEVICE LIMIT REACHED/);
    expect((await t.as(org.owner.authId, "select public.remove_prosm_time_device($1)", [id("shared")])).error).toBeNull();
    expect((await t.as(b.authId, "select public.register_prosm_time_device($1)", [id("another")])).error).toBeNull();
  });
});
