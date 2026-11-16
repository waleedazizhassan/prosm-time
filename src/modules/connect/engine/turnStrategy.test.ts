// TURN bandwidth strategy (owner 2026-11-16): 360p / 15 fps, sound first, and what each connection carried is
// measured from its own counters - split by route, relay bytes per relay host.
import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async () => ({ data: { success: true }, error: null }));
vi.mock("./ConnectEngine", () => ({ ConnectEngine: { supabase: { rpc } } }));
const { UsageMeter, VIDEO_CONSTRAINTS, relayHost, reportUsage, tuneSenders } = await import("./rtc");

function statsOf(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map(entries.map((e) => [e.id as string, e]));
  return { forEach: (cb: (v: unknown) => void) => map.forEach((v) => cb(v)), get: (id: string) => map.get(id) } as unknown as RTCStatsReport;
}

describe("defaults", () => {
  it("video starts at 360p and 15 frames", () => {
    expect(VIDEO_CONSTRAINTS).toMatchObject({ height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } });
  });
  it("relay host: the same rule connect-ice uses for its quotas", () => {
    expect(relayHost("turn:global.relay.metered.ca:443?transport=tcp")).toBe("global.relay.metered.ca");
    expect(relayHost("turns:Relay1.ExpressTURN.com:5349")).toBe("relay1.expressturn.com");
    expect(relayHost("turn:[2001:db8::1]:3478")).toBe("2001:db8::1");
  });
});

describe("sound first", () => {
  it("audio high priority at 32 kb/s; video low priority, 15 fps, at most 450 kb/s", async () => {
    const make = (kind: string) => {
      const params = { encodings: [{}] } as unknown as RTCRtpSendParameters;
      return { track: { kind }, getParameters: () => params, setParameters: vi.fn(async () => undefined), params };
    };
    const audio = make("audio");
    const video = make("video");
    await tuneSenders({ getSenders: () => [audio, video] } as unknown as RTCPeerConnection);
    expect(audio.params.encodings[0]).toMatchObject({ priority: "high", networkPriority: "high", maxBitrate: 32_000 });
    expect(video.params.encodings[0]).toMatchObject({ priority: "low", networkPriority: "low", maxFramerate: 15, maxBitrate: 450_000 });
  });
});

describe("usage meter", () => {
  it("splits what passed by route; relay bytes go to their relay host; each reading counts only what is new", async () => {
    let round = 0;
    const pc = {
      getStats: async () => {
        round += 1;
        return statsOf([
          { id: "T", type: "transport", selectedCandidatePairId: "P2" },
          { id: "P1", type: "candidate-pair", localCandidateId: "L1", bytesSent: 1000, bytesReceived: 1000 },
          { id: "P2", type: "candidate-pair", localCandidateId: "L2", bytesSent: 5000 * round, bytesReceived: 5000 * round },
          { id: "L1", type: "local-candidate", candidateType: "srflx" },
          { id: "L2", type: "local-candidate", candidateType: "relay", url: "turn:global.relay.metered.ca:80?transport=udp" },
        ]);
      },
    } as unknown as RTCPeerConnection;
    const meter = new UsageMeter(pc);
    const first = await meter.take();
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "srflx", server: null, bytes: 2000 }),
      expect.objectContaining({ route: "relay", server: "global.relay.metered.ca", bytes: 10000 }),
    ]));
    const second = await meter.take();
    // the direct pair carried nothing new
    expect(second).toEqual([expect.objectContaining({ route: "relay", bytes: 10000 })]);
  });

  it("reports each slice to the usage log; nothing for an empty slice", async () => {
    rpc.mockClear();
    await reportUsage("video", "11111111-1111-1111-1111-111111111111", [
      { route: "relay", server: "global.relay.metered.ca", bytes: 1234.6, seconds: 30 },
      { route: "srflx", server: null, bytes: 0, seconds: 0 },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_prosm_time_connect_usage", expect.objectContaining({ p_kind: "video", p_route: "relay", p_server: "global.relay.metered.ca", p_bytes: 1235, p_seconds: 30 }));
  });
});
