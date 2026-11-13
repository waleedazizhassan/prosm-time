import type { RealtimeChannel } from "@supabase/supabase-js";

import { ConnectEngine } from "./ConnectEngine";
import { ICE_SERVERS, QualityGuard, localMedia, signalChannel, tuneOpus, type LinkQuality, type Signal } from "./rtc";

// PROSM Connect - a call between two people (owner 2026-11-13). The switchboard rings the other person (a push wakes a
// closed app); once they answer, both join the call's private channel and the sound and picture go straight between
// the two devices. A changed network reconnects (ICE restart) instead of dropping; a connection that cannot be made in
// about 15 seconds says so and offers a voice message instead; nobody answering in 45 seconds is a missed call.

export type CallState = "calling" | "ringing" | "connecting" | "connected" | "reconnecting" | "ended" | "failed" | "busy" | "rejected" | "missed";

export class CallSession {
  readonly callId: string;
  readonly peerId: string;
  readonly media: "audio" | "video";
  readonly outgoing: boolean;
  state: CallState;
  local: MediaStream | null = null;
  remote = new MediaStream();
  quality: LinkQuality = { level: 0, rttMs: null, lossPct: null, sendKbps: null };
  remoteVideoOff = false;
  localVideoOff = false;
  muted = false;
  startedAt: number | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RealtimeChannel | null = null;
  private send: ((signal: Omit<Signal, "from">) => Promise<void>) | null = null;
  private guard: QualityGuard | null = null;
  private timers: number[] = [];
  private everConnected = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;

  private constructor(callId: string, peerId: string, media: "audio" | "video", outgoing: boolean) {
    this.callId = callId;
    this.peerId = peerId;
    this.media = media;
    this.outgoing = outgoing;
    this.state = outgoing ? "calling" : "ringing";
    // the server tells of answers and hang-ups too (if the channel is not joined yet)
    this.unsubscribe = ConnectEngine.on("call-signal", (payload) => {
      const p = payload as { callId: string; state: string; status?: string };
      if (p.callId !== this.callId) return;
      if (p.state === "reject") this.finish("rejected", false);
      else if (p.state === "busy") this.finish("busy", false);
      else if (p.state === "ended") this.finish(p.status === "failed" ? "failed" : p.status === "missed" ? "missed" : "ended", false);
      else if (p.state === "answered-elsewhere" && !this.outgoing && this.state === "ringing") this.finish("ended", false);
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }

  private set(state: CallState) {
    this.state = state;
    this.changed();
  }

  /** Calling someone. */
  static async start(peerId: string, media: "audio" | "video"): Promise<CallSession> {
    const { data, error } = await ConnectEngine.supabase.rpc("prosm_time_connect_start_call", { p_callee: peerId, p_media: media });
    if (error) throw new Error(error.message);
    const result = data as { callId: string; status: string };
    const session = new CallSession(result.callId, peerId, media, true);
    if (result.status === "busy") {
      session.set("busy");
      return session;
    }
    session.local = await localMedia(media === "video").catch(() => null);
    await session.join();
    // nobody answers in 45 seconds: missed
    session.timers.push(window.setTimeout(() => {
      if (session.state === "calling") void session.hangup("missed");
    }, 45000));
    return session;
  }

  /** A call coming in (it rings until answered, declined or given up). */
  static incoming(callId: string, peerId: string, media: "audio" | "video"): CallSession {
    const session = new CallSession(callId, peerId, media, false);
    session.timers.push(window.setTimeout(() => {
      if (session.state === "ringing") session.finish("missed", false);
    }, 45000));
    return session;
  }

  async answer() {
    if (this.state !== "ringing") return;
    this.set("connecting");
    this.local = await localMedia(this.media === "video").catch(() => null);
    const { data, error } = await ConnectEngine.supabase.rpc("prosm_time_connect_answer_call", { p_call: this.callId, p_action: "accept" });
    if (error || (data as { status: string }).status !== "accepted") {
      this.finish("ended", false);
      return;
    }
    await this.join();
    await this.send?.({ type: "ready" });
    this.watchConnection();
  }

  async decline(busy = false) {
    await ConnectEngine.supabase.rpc("prosm_time_connect_answer_call", { p_call: this.callId, p_action: busy ? "busy" : "reject" });
    this.finish("rejected", false);
  }

  private async join() {
    const { channel, send } = await signalChannel(`connect:call:${this.callId}`, (signal) => void this.onSignal(signal));
    this.channel = channel;
    this.send = send;
  }

  private makePeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
    this.pc = pc;
    if (this.local) for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    // a picture can still come from the other side (one of us may have no camera)
    if (this.media === "video" && !this.local?.getVideoTracks().length) pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      if (!this.remote.getTracks().includes(event.track)) this.remote.addTrack(event.track);
      this.changed();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) void this.send?.({ type: "ice", candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        this.everConnected = true;
        if (!this.startedAt) this.startedAt = Date.now();
        this.set("connected");
      } else if (s === "disconnected") {
        this.set("reconnecting");
        // a short drop (a changed network): restart the path if it does not come back by itself
        this.timers.push(window.setTimeout(() => {
          if (this.pc?.connectionState === "disconnected") void this.restart();
        }, 2500));
      } else if (s === "failed") {
        if (this.everConnected) void this.restart();
        else void this.hangup("failed");
      }
    };
    this.guard = new QualityGuard(pc, (off) => {
      this.localVideoOff = off;
      void this.send?.({ type: "video-off", off });
      this.changed();
    });
    const tick = window.setInterval(async () => {
      if (!this.pc || this.state === "ended") return;
      this.quality = await this.guard!.sample().catch(() => this.quality);
      this.changed();
    }, 2000);
    this.timers.push(tick);
    return pc;
  }

  private watchConnection() {
    // no connection in 15 seconds: tell the person, offer a voice message
    this.timers.push(window.setTimeout(() => {
      if (!this.everConnected && this.state !== "ended") void this.hangup("failed");
    }, 15000 + (this.outgoing ? 0 : 5000)));
  }

  private async restart() {
    if (!this.pc || !this.outgoing) {
      // the caller leads a restart; the other side asks for one
      void this.send?.({ type: "restart" });
      return;
    }
    this.set("reconnecting");
    const offer = await this.pc.createOffer({ iceRestart: true });
    offer.sdp = tuneOpus(offer.sdp ?? "");
    await this.pc.setLocalDescription(offer);
    await this.send?.({ type: "offer", sdp: offer.sdp, restart: true });
  }

  private async onSignal(signal: Signal) {
    switch (signal.type) {
      case "ready": {
        if (!this.outgoing) return;
        this.set("connecting");
        const pc = this.pc ?? this.makePeer();
        const offer = await pc.createOffer();
        offer.sdp = tuneOpus(offer.sdp ?? "");
        await pc.setLocalDescription(offer);
        await this.send?.({ type: "offer", sdp: offer.sdp });
        this.watchConnection();
        break;
      }
      case "offer": {
        const pc = this.pc ?? this.makePeer();
        await pc.setRemoteDescription({ type: "offer", sdp: String(signal.sdp) });
        for (const candidate of this.pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => undefined);
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp ?? "");
        await pc.setLocalDescription(answer);
        await this.send?.({ type: "answer", sdp: answer.sdp });
        break;
      }
      case "answer": {
        if (!this.pc) return;
        await this.pc.setRemoteDescription({ type: "answer", sdp: String(signal.sdp) });
        for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => undefined);
        break;
      }
      case "ice": {
        const candidate = signal.candidate as RTCIceCandidateInit;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => undefined);
        else this.pendingIce.push(candidate);
        break;
      }
      case "restart":
        if (this.outgoing) void this.restart();
        break;
      case "video-off":
        this.remoteVideoOff = Boolean(signal.off);
        this.changed();
        break;
      case "hangup":
        this.finish(signal.reason === "failed" ? "failed" : "ended", false);
        break;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.changed();
  }

  /** The person turns the picture off (or back on) - "sound only". */
  toggleVideo() {
    const track = this.local?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.localVideoOff = !track.enabled;
    void this.send?.({ type: "video-off", off: this.localVideoOff });
    this.changed();
  }

  async flipCamera() {
    const track = this.local?.getVideoTracks()[0];
    if (!track || !this.pc) return;
    const facing = track.getSettings().facingMode === "environment" ? "user" : "environment";
    const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }).catch(() => null);
    const next = fresh?.getVideoTracks()[0];
    if (!next) return;
    await this.pc.getSenders().find((s) => s.track?.kind === "video")?.replaceTrack(next);
    this.local!.removeTrack(track);
    track.stop();
    this.local!.addTrack(next);
    this.changed();
  }

  async hangup(reason: "hangup" | "failed" | "missed" | "cancelled" = "hangup") {
    await this.send?.({ type: "hangup", reason }).catch(() => undefined);
    await ConnectEngine.supabase.rpc("prosm_time_connect_end_call", { p_call: this.callId, p_reason: reason === "hangup" && !this.everConnected && this.outgoing ? "cancelled" : reason });
    this.finish(reason === "failed" ? "failed" : reason === "missed" ? "missed" : "ended", false);
  }

  private finish(state: CallState, notify: boolean) {
    if (["ended", "failed", "busy", "rejected", "missed"].includes(this.state) && this.state !== "busy") return;
    if (notify) void this.send?.({ type: "hangup" });
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    this.pc?.close();
    this.pc = null;
    this.local?.getTracks().forEach((t) => t.stop());
    if (this.channel) void ConnectEngine.supabase.removeChannel(this.channel);
    this.channel = null;
    this.unsubscribe?.();
    this.set(state);
  }

  get stats() {
    return this.pc;
  }
}
