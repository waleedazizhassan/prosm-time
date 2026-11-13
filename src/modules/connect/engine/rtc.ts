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

/** The camera and the microphone - asked for only when the person starts or answers (owner: never remotely). */
export async function localMedia(video: boolean): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false });
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
  private readonly steps = [900_000, 500_000, 250_000, 120_000];

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
