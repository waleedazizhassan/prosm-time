import type { RealtimeChannel } from "@supabase/supabase-js";

import { ConnectEngine } from "./ConnectEngine";

// PROSM Connect - what calls and meetings share (owner 2026-11-13: no paid service - free STUN only, the content goes
// straight between devices; a call must not drop, and video that cannot hold becomes sound only).
export const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

export type Signal = { type: string; from: string; to?: string; [key: string]: unknown };

/** A private signalling channel (offer / answer / ice / hangup ...) - broadcast only, nothing stored. */
export async function signalChannel(topic: string, onSignal: (signal: Signal) => void, presenceKey?: string, onPresence?: () => void): Promise<{ channel: RealtimeChannel; send: (signal: Omit<Signal, "from">) => Promise<void> }> {
  const supabase = ConnectEngine.supabase;
  const me = ConnectEngine.me!.userId;
  const channel = supabase.channel(topic, { config: { private: true, broadcast: { self: false, ack: true }, presence: presenceKey ? { key: presenceKey } : undefined } });
  channel.on("broadcast", { event: "signal" }, (message) => {
    const signal = message.payload as Signal;
    if (signal.from === me || (signal.to && signal.to !== me)) return;
    onSignal(signal);
  });
  // presence listeners must be in place before joining (Supabase Realtime)
  if (onPresence) channel.on("presence", { event: "sync" }, onPresence);
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("CHANNEL TIMEOUT")), 12000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        window.clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        window.clearTimeout(timer);
        reject(new Error(status));
      }
    });
  });
  const send = async (signal: Omit<Signal, "from">) => {
    await channel.send({ type: "broadcast", event: "signal", payload: { ...signal, from: me } });
  };
  return { channel, send };
}

export const VIDEO_CONSTRAINTS: MediaTrackConstraints = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } };
/** The video's starting ceiling; QualityGuard steps it down on a weak network, then turns the picture off. */
export const VIDEO_START_BITRATE = 450_000;

/** The camera and the microphone - asked for only when the person starts or answers (owner: never remotely). */
export async function localMedia(video: boolean): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    // owner 2026-11-16 (TURN strategy): 360p at 15 frames by default - clear enough for a face, a fraction of the data
    return await navigator.mediaDevices.getUserMedia({ audio, video: video ? VIDEO_CONSTRAINTS : false });
  } catch (error) {
    // no camera (or refused): the call goes on with sound
    if (video) return navigator.mediaDevices.getUserMedia({ audio, video: false });
    throw error;
  }
}

/** Opus with in-band error correction (FEC) and DTX - holds up on a weak mobile network. */
export function tuneOpus(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!match) return sdp;
  const pt = match[1];
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_all, params: string) => {
      const extra = ["useinbandfec=1", "usedtx=1", "stereo=0", "maxaveragebitrate=32000"].filter((p) => !params.includes(p.split("=")[0]));
      return `a=fmtp:${pt} ${[params, ...extra].join(";")}`;
    });
  }
  return sdp.replace(match[0], `${match[0]}\r\na=fmtp:${pt} useinbandfec=1;usedtx=1;maxaveragebitrate=32000`);
}

export interface LinkQuality {
  /** 0 (none) .. 4 (excellent) */
  level: number;
  rttMs: number | null;
  lossPct: number | null;
  sendKbps: number | null;
}

/** Reads the connection's health and adapts the video: lower and lower, then off (sound only) - never a drop. */
export class QualityGuard {
  private last: { at: number; bytes: number; lost: number; received: number } | null = null;
  private weak = 0;
  private strong = 0;
  private step = 0;
  videoOff = false;
  private readonly steps = [VIDEO_START_BITRATE, 300_000, 180_000, 100_000];

  constructor(private pc: RTCPeerConnection, private onVideoOff: (off: boolean) => void) {}

  async sample(): Promise<LinkQuality> {
    const stats = await this.pc.getStats();
    let rtt: number | null = null;
    let available: number | null = null;
    let bytes = 0;
    let lost = 0;
    let received = 0;
    let limited = false;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
        if (typeof report.currentRoundTripTime === "number") rtt = report.currentRoundTripTime * 1000;
        if (typeof report.availableOutgoingBitrate === "number") available = report.availableOutgoingBitrate;
      }
      if (report.type === "outbound-rtp") {
        bytes += report.bytesSent ?? 0;
        if (report.kind === "video" && report.qualityLimitationReason === "bandwidth") limited = true;
      }
      if (report.type === "inbound-rtp") {
        lost += report.packetsLost ?? 0;
        received += report.packetsReceived ?? 0;
      }
    });
    const now = performance.now();
    let kbps: number | null = null;
    let loss: number | null = null;
    if (this.last) {
      const seconds = (now - this.last.at) / 1000;
      if (seconds > 0) kbps = ((bytes - this.last.bytes) * 8) / 1000 / seconds;
      const dLost = lost - this.last.lost;
      const dRecv = received - this.last.received;
      if (dLost + dRecv > 0) loss = (dLost / (dLost + dRecv)) * 100;
    }
    this.last = { at: now, bytes, lost, received };
    const rttMs = rtt as number | null;
    const level = rttMs === null ? 0 : rttMs < 150 && (loss ?? 0) < 2 ? 4 : rttMs < 300 && (loss ?? 0) < 5 ? 3 : rttMs < 600 && (loss ?? 0) < 12 ? 2 : 1;
    await this.adapt(limited || (available !== null && (available as number) < 200_000) || (loss ?? 0) > 10, (available ?? 0) > 800_000 && (loss ?? 0) < 2);
    return { level, rttMs, lossPct: loss, sendKbps: kbps };
  }

  private async adapt(weak: boolean, strong: boolean) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    this.weak = weak ? this.weak + 1 : 0;
    this.strong = strong ? this.strong + 1 : 0;
    if (this.weak >= 3) {
      this.weak = 0;
      if (this.step < this.steps.length - 1) {
        this.step += 1;
        await setMaxBitrate(sender, this.steps[this.step]);
      } else if (!this.videoOff) {
        this.videoOff = true;
        if (sender.track) sender.track.enabled = false;
        this.onVideoOff(true);
      }
    } else if (this.strong >= 5) {
      this.strong = 0;
      if (this.videoOff) {
        this.videoOff = false;
        if (sender.track) sender.track.enabled = true;
        this.onVideoOff(false);
      } else if (this.step > 0) {
        this.step -= 1;
        await setMaxBitrate(sender, this.steps[this.step]);
      }
    }
  }
}

async function setMaxBitrate(sender: RTCRtpSender, bitrate: number) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    params.encodings[0].scaleResolutionDownBy = bitrate < 300_000 ? 2 : 1;
    await sender.setParameters(params);
  } catch {
    // older engines: the browser adapts by itself
  }
}

/**
 * Phase G (owner 2026-11-15): how a connected call actually travels - "host" (same network), "srflx" (direct through
 * the internet, found by STUN) or "relay" (through a TURN server). Measured instead of guessed; null if unknown.
 */
export async function connectionRoute(pc: RTCPeerConnection): Promise<"host" | "srflx" | "prflx" | "relay" | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | null = null;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) pairId = report.selectedCandidatePairId;
    });
    let pair: RTCIceCandidatePairStats | null = null;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && (report.id === pairId || (!pairId && report.state === "succeeded" && report.nominated))) pair = report;
    });
    if (!pair) return null;
    const local = stats.get((pair as RTCIceCandidatePairStats).localCandidateId) as { candidateType?: string } | undefined;
    const type = local?.candidateType;
    return type === "host" || type === "srflx" || type === "prflx" || type === "relay" ? type : null;
  } catch {
    return null;
  }
}

/**
 * Phase G (owner 2026-11-15): the ICE servers for a call - STUN plus the free TURN relays the server holds as secrets
 * (connect-ice). Asked once and kept for 30 minutes; if the server cannot be reached the call still tries STUN alone.
 */
let iceCache: { at: number; servers: RTCIceServer[] } | null = null;
export async function loadIceServers(invoke: (name: string) => Promise<{ data: unknown; error: unknown }>): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() - iceCache.at < 30 * 60 * 1000) return iceCache.servers;
  try {
    const { data, error } = await invoke("connect-ice");
    const servers = (data as { data?: { iceServers?: RTCIceServer[] } } | null)?.data?.iceServers;
    if (!error && Array.isArray(servers) && servers.length > 0) {
      iceCache = { at: Date.now(), servers };
      return servers;
    }
  } catch {
    // fall back to STUN below
  }
  return ICE_SERVERS;
}

/**
 * TURN strategy (owner 2026-11-16): sound first. Audio is sent at high priority with Opus's own 32 kb/s ceiling; the
 * picture at low priority, 15 frames, starting at 450 kb/s - when the network is short the picture gives way, never
 * the sound. Applied once the connection is up (some engines refuse sender parameters before negotiation).
 */
export async function tuneSenders(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    const kind = sender.track?.kind;
    if (!kind) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const encoding = params.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string; maxFramerate?: number };
      if (kind === "audio") {
        encoding.priority = "high";
        encoding.networkPriority = "high";
        encoding.maxBitrate = 32_000;
      } else {
        encoding.priority = "low";
        encoding.networkPriority = "low";
        encoding.maxFramerate = 15;
        if (!encoding.maxBitrate || encoding.maxBitrate > VIDEO_START_BITRATE) encoding.maxBitrate = VIDEO_START_BITRATE;
      }
      await sender.setParameters(params);
    } catch {
      // an engine without these settings adapts by itself
    }
  }
}

/** turn:host:port?transport=udp -> host (lower case). The same rule as connect-ice, so reports match its quotas. */
export function relayHost(url: string): string {
  return url.replace(/^turns?:/i, "").replace(/^\/\//, "").split("?")[0].replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

export type Route = "host" | "srflx" | "prflx" | "relay" | "unknown";
export interface UsageSlice { route: Route; server: string | null; bytes: number; seconds: number }

/**
 * TURN strategy (owner 2026-11-16): what a connection actually carried, and how - read from its own counters.
 * Each call to take() returns what passed since the previous one, split by route (a call can move from direct to a
 * relay and back after a network change). Only this device's own relay allocation is counted as relay, so the
 * organisation's reports add up to what each relay server carried.
 */
export class UsageMeter {
  private lastBytes = new Map<string, number>();
  private lastAt = performance.now();
  constructor(private pc: RTCPeerConnection) {}

  async take(): Promise<UsageSlice[]> {
    const now = performance.now();
    const seconds = Math.max(0, Math.round((now - this.lastAt) / 1000));
    this.lastAt = now;
    let stats: RTCStatsReport;
    try {
      stats = await this.pc.getStats();
    } catch {
      return [];
    }
    let selected: string | null = null;
    stats.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) selected = r.selectedCandidatePairId; });
    const slices = new Map<string, UsageSlice>();
    stats.forEach((r) => {
      if (r.type !== "candidate-pair") return;
      const total = (r.bytesSent ?? 0) + (r.bytesReceived ?? 0);
      const delta = total - (this.lastBytes.get(r.id) ?? 0);
      this.lastBytes.set(r.id, total);
      if (delta <= 0) return;
      const local = stats.get(r.localCandidateId) as { candidateType?: string; url?: string } | undefined;
      const type = local?.candidateType;
      const route: Route = type === "host" || type === "srflx" || type === "prflx" || type === "relay" ? type : "unknown";
      const server = route === "relay" && local?.url ? relayHost(local.url) : null;
      const key = `${route}|${server ?? ""}`;
      const slice = slices.get(key) ?? { route, server, bytes: 0, seconds: 0 };
      slice.bytes += delta;
      // the time belongs to the path in use now
      if (r.id === selected || (!selected && r.nominated)) slice.seconds = seconds;
      slices.set(key, slice);
    });
    return [...slices.values()];
  }
}

/** Sends a meter's slices to the organisation's usage log (fire and forget - a lost report never touches the call). */
export async function reportUsage(kind: "audio" | "video" | "meeting", refId: string | null, slices: UsageSlice[]): Promise<void> {
  for (const slice of slices) {
    if (slice.bytes <= 0 && slice.seconds <= 0) continue;
    await ConnectEngine.supabase.rpc("record_prosm_time_connect_usage", {
      p_kind: kind, p_ref_id: refId, p_route: slice.route, p_server: slice.server, p_bytes: Math.round(slice.bytes), p_seconds: Math.min(7200, slice.seconds),
    }).then(() => undefined, () => undefined);
  }
}

