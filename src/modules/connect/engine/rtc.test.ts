import { describe, expect, it, vi } from "vitest";

describe("loadIceServers (Connect phase G)", () => {
  it("uses the server's STUN + TURN list, and keeps it", async () => {
    vi.resetModules();
    const { loadIceServers } = await import("./rtc");
    const servers = [{ urls: ["stun:x"] }, { urls: ["turn:relay.example:3478"], username: "u", credential: "c" }];
    const invoke = vi.fn(async () => ({ data: { success: true, data: { iceServers: servers } }, error: null }));
    expect(await loadIceServers(invoke)).toEqual(servers);
    expect(await loadIceServers(invoke)).toEqual(servers);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to STUN when the server cannot be reached", async () => {
    vi.resetModules();
    const { loadIceServers, ICE_SERVERS } = await import("./rtc");
    expect(await loadIceServers(async () => { throw new Error("offline"); })).toEqual(ICE_SERVERS);
    expect(await loadIceServers(async () => ({ data: null, error: new Error("500") }))).toEqual(ICE_SERVERS);
  });
});
