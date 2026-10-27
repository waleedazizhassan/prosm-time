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
