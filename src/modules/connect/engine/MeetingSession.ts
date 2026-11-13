import type { RealtimeChannel } from "@supabase/supabase-js";

import { ConnectEngine } from "./ConnectEngine";
import { ICE_SERVERS, QualityGuard, localMedia, signalChannel, tuneOpus, type Signal } from "./rtc";

// PROSM Connect - a small meeting, straight between the devices (owner 2026-11-13: no media server). Every device
// connects with every other (a mesh): up to 4 with video, 8 with sound only, enforced on the server. The one with the
// smaller id makes the offer, so two never cross. Who is present comes from the channel's presence. The host can
// mute everyone, pin someone in the middle and stop recording; anyone can raise a hand; the meeting's chat is
// broadcast only and gone with the meeting. Recording happens on the recorder's device only, and everyone is told
// by name while it lasts.

export interface Peer {
  userId: string;
  stream: MediaStream;
  muted: boolean;
  videoOff: boolean;
  hand: boolean;
  recording: boolean;
  level: number;
  speaking: boolean;
}

export interface MeetingChat { from: string; text: string; at: number }

export class MeetingSession {
  readonly meetingId: string;
  media: "audio" | "video" = "audio";
  hostId = "";
  recordingAllowed = true;
  recordingFeature = false;
  screenShareFeature = false;
  local: MediaStream | null = null;
  peers = new Map<string, Peer>();
  chat: MeetingChat[] = [];
  pinned: string | null = null;
  sharingBy: string | null = null;
  myHand = false;
  muted = false;
  videoOff = false;
  recording = false;
  ended = false;
  error: string | null = null;
  private connections = new Map<string, RTCPeerConnection>();
  private guards = new Map<string, QualityGuard>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private attemptAt = new Map<string, number>();
  private channel: RealtimeChannel | null = null;
  private send: ((signal: Omit<Signal, "from">) => Promise<void>) | null = null;
  private listeners = new Set<() => void>();
  private timers: number[] = [];
  private camera: MediaStreamTrack | null = null;
  private screen: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recordChunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  onRecorded: ((blob: Blob) => void) | null = null;

  constructor(meetingId: string) {
    this.meetingId = meetingId;
  }

  get me() {
    return ConnectEngine.me!.userId;
  }

  get isHost() {
    return this.hostId === this.me;
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

  /** Starting a meeting with these people (the host). */
  static async start(media: "audio" | "video", invitees: string[], title: string | null): Promise<MeetingSession> {
    const { data, error } = await ConnectEngine.supabase.rpc("prosm_time_connect_start_meeting", { p_media: media, p_invitees: invitees, p_title: title });
    if (error) throw new Error(error.message);
    const session = new MeetingSession(String(data));
    await session.join();
    return session;
  }

  async join() {
    const { error } = await ConnectEngine.supabase.rpc("prosm_time_connect_join_meeting", { p_meeting_id: this.meetingId });
    if (error) throw new Error(error.message);
    const { data } = await ConnectEngine.supabase.rpc("get_prosm_time_connect_meeting", { p_meeting: this.meetingId });
    const info = data as { hostId: string; media: "audio" | "video"; recordingAllowed: boolean; recordingFeature: boolean; screenShareFeature: boolean };
    this.hostId = info.hostId;
    this.media = info.media;
    this.recordingAllowed = info.recordingAllowed;
    this.recordingFeature = info.recordingFeature;
    this.screenShareFeature = info.screenShareFeature;
    this.local = await localMedia(this.media === "video").catch(() => null);
    this.camera = this.local?.getVideoTracks()[0] ?? null;
    const { channel, send } = await signalChannel(`connect:meeting:${this.meetingId}`, (signal) => void this.onSignal(signal), this.me, () => this.syncPresence());
    this.channel = channel;
    this.send = send;
    await channel.track({ userId: this.me, at: Date.now() });
    this.timers.push(window.setInterval(() => void this.sampleQuality(), 2000));
    // a pair that did not connect (many at once on a weak network) is tried again, never left silent
    this.timers.push(window.setInterval(() => this.heal(), 3000));
    this.changed();
  }

  private syncPresence() {
    if (!this.channel) return;
    const present = new Set(Object.keys(this.channel.presenceState()));
    present.delete(this.me);
    for (const userId of present) {
      if (!this.connections.has(userId) && this.me < userId) void this.call(userId);
      if (!this.peers.has(userId)) this.peers.set(userId, blankPeer(userId));
    }
    for (const userId of [...this.peers.keys()]) {
      if (!present.has(userId)) this.drop(userId);
    }
    // somebody arriving while a recording runs hears of it at once
    if (this.recording) void this.send?.({ type: "recording", on: true });
    this.changed();
  }

  private heal() {
    if (!this.channel || this.ended) return;
    const present = Object.keys(this.channel.presenceState()).filter((id) => id !== this.me);
    for (const id of present) {
      const pc = this.connections.get(id);
      const state = pc?.connectionState;
      if (state === "connected" || state === "connecting") continue;
      if (Date.now() - (this.attemptAt.get(id) ?? 0) < 7000) continue;
      this.attemptAt.set(id, Date.now());
      this.reset(id);
      if (this.me < id) void this.call(id);
      else void this.send?.({ type: "please-offer", to: id });
    }
  }

  private reset(userId: string) {
    this.connections.get(userId)?.close();
    this.connections.delete(userId);
    this.guards.delete(userId);
    this.pendingIce.delete(userId);
    const peer = this.peers.get(userId);
    if (peer) peer.stream = new MediaStream();
  }

  private peer(userId: string): RTCPeerConnection {
    const existing = this.connections.get(userId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
    this.connections.set(userId, pc);
    if (this.local) for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    if (this.media === "video" && !this.local?.getVideoTracks().length) pc.addTransceiver("video", { direction: "recvonly" });
    if (!this.peers.has(userId)) this.peers.set(userId, blankPeer(userId));
    pc.ontrack = (event) => {
      const peer = this.peers.get(userId) ?? blankPeer(userId);
      if (!peer.stream.getTracks().includes(event.track)) peer.stream.addTrack(event.track);
      this.peers.set(userId, peer);
      this.changed();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) void this.send?.({ type: "ice", to: userId, candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.me < userId) void this.call(userId, true);
      this.changed();
    };
    this.guards.set(userId, new QualityGuard(pc, (off) => {
      if (off) void this.send?.({ type: "weak-network" });
    }));
    return pc;
  }

  private async call(userId: string, restart = false) {
    this.attemptAt.set(userId, Date.now());
    const pc = this.peer(userId);
    const offer = await pc.createOffer({ iceRestart: restart });
    offer.sdp = tuneOpus(offer.sdp ?? "");
    await pc.setLocalDescription(offer);
    await this.send?.({ type: "offer", to: userId, sdp: offer.sdp });
  }

  private async onSignal(signal: Signal) {
    const from = signal.from;
    switch (signal.type) {
      case "please-offer":
        if (this.me < from) {
          this.attemptAt.set(from, Date.now());
          this.reset(from);
          void this.call(from);
        }
        break;
      case "offer": {
        const stale = this.connections.get(from);
        if (stale && (stale.signalingState !== "stable" || ["failed", "closed", "disconnected"].includes(stale.connectionState))) this.reset(from);
        const pc = this.peer(from);
        await pc.setRemoteDescription({ type: "offer", sdp: String(signal.sdp) });
        for (const c of this.pendingIce.get(from)?.splice(0) ?? []) await pc.addIceCandidate(c).catch(() => undefined);
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp ?? "");
        await pc.setLocalDescription(answer);
        await this.send?.({ type: "answer", to: from, sdp: answer.sdp });
        break;
      }
      case "answer": {
        const pc = this.connections.get(from);
        if (!pc) return;
        await pc.setRemoteDescription({ type: "answer", sdp: String(signal.sdp) });
        for (const c of this.pendingIce.get(from)?.splice(0) ?? []) await pc.addIceCandidate(c).catch(() => undefined);
        break;
      }
      case "ice": {
        const pc = this.connections.get(from);
        const candidate = signal.candidate as RTCIceCandidateInit;
        if (pc?.remoteDescription) await pc.addIceCandidate(candidate).catch(() => undefined);
        else this.pendingIce.set(from, [...(this.pendingIce.get(from) ?? []), candidate]);
        break;
      }
      case "state": {
        const peer = this.peers.get(from);
        if (peer) Object.assign(peer, { muted: Boolean(signal.muted), videoOff: Boolean(signal.videoOff), hand: Boolean(signal.hand) });
        break;
      }
      case "mute-all":
        if (from === this.hostId && !this.muted) this.toggleMute();
        break;
      case "pin":
        if (from === this.hostId) this.pinned = (signal.userId as string | null) ?? null;
        break;
      case "share":
        this.sharingBy = signal.on ? from : this.sharingBy === from ? null : this.sharingBy;
        break;
      case "chat":
        this.chat = [...this.chat, { from, text: String(signal.text ?? "").slice(0, 1000), at: Date.now() }].slice(-200);
        break;
      case "recording": {
        const peer = this.peers.get(from);
        if (peer) peer.recording = Boolean(signal.on);
        break;
      }
      case "recording-off":
        if (from === this.hostId) {
          this.recordingAllowed = false;
          if (this.recording) this.stopRecording();
        }
        break;
      case "end":
        if (from === this.hostId) this.close(false);
        break;
    }
    this.changed();
  }

  private broadcastState() {
    void this.send?.({ type: "state", muted: this.muted, videoOff: this.videoOff, hand: this.myHand });
  }

  toggleMute() {
    this.muted = !this.muted;
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.broadcastState();
    this.changed();
  }

  /** Sound only (also offered on a weak network). */
  toggleVideo() {
    const track = this.local?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.videoOff = !track.enabled;
    this.broadcastState();
    this.changed();
  }

  raiseHand() {
    this.myHand = !this.myHand;
    this.broadcastState();
    this.changed();
  }

  muteAll() {
    if (this.isHost) void this.send?.({ type: "mute-all" });
  }

  pin(userId: string | null) {
    if (!this.isHost) return;
    this.pinned = userId;
    void this.send?.({ type: "pin", userId });
    this.changed();
  }

  say(text: string) {
    const clean = text.trim().slice(0, 1000);
    if (!clean) return;
    this.chat = [...this.chat, { from: this.me, text: clean, at: Date.now() }];
    void this.send?.({ type: "chat", text: clean });
    this.changed();
  }

  /** Screen sharing (computer and Android); the camera comes back when it stops. */
  async toggleShare() {
    if (this.screen) {
      this.screen.getTracks().forEach((t) => t.stop());
      this.screen = null;
      await this.replaceVideo(this.camera);
      this.sharingBy = null;
      void this.send?.({ type: "share", on: false });
      this.changed();
      return;
    }
    if (!navigator.mediaDevices.getDisplayMedia) return;
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).catch(() => null);
    const track = screen?.getVideoTracks()[0];
    if (!screen || !track) return;
    this.screen = screen;
    track.onended = () => void this.toggleShare();
    await this.replaceVideo(track);
    this.sharingBy = this.me;
    void this.send?.({ type: "share", on: true });
    this.changed();
  }

  private async replaceVideo(track: MediaStreamTrack | null) {
    for (const pc of this.connections.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video" || (!s.track && s === pc.getSenders()[1]));
      if (sender) await sender.replaceTrack(track).catch(() => undefined);
    }
  }

  /** Recording on this device only; everyone is told by name. */
  startRecording(videos: HTMLVideoElement[]) {
    if (!this.recordingAllowed || !this.recordingFeature || this.recording || typeof MediaRecorder === "undefined") return false;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      if (!this.recording) return;
      ctx.fillStyle = "#060c1a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const live = videos.filter((v) => v.videoWidth > 0);
      const cols = Math.ceil(Math.sqrt(Math.max(live.length, 1)));
      const rows = Math.ceil(Math.max(live.length, 1) / cols);
      live.forEach((v, i) => {
        const w = canvas.width / cols;
        const h = canvas.height / rows;
        ctx.drawImage(v, (i % cols) * w, Math.floor(i / cols) * h, w, h);
      });
      requestAnimationFrame(draw);
    };
    this.audioContext = new AudioContext();
    const mix = this.audioContext.createMediaStreamDestination();
    const streams = [this.local, ...[...this.peers.values()].map((p) => p.stream)].filter((s): s is MediaStream => Boolean(s && s.getAudioTracks().length));
    for (const s of streams) this.audioContext.createMediaStreamSource(s).connect(mix);
    const out = new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...mix.stream.getAudioTracks()]);
    this.recordChunks = [];
    this.recorder = new MediaRecorder(out, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm" });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.recordChunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.recordChunks, { type: "video/webm" });
      this.recordChunks = [];
      if (blob.size) this.onRecorded?.(blob);
    };
    this.recording = true;
    this.recorder.start(1000);
    draw();
    void this.send?.({ type: "recording", on: true });
    this.changed();
    return true;
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = false;
    this.recorder?.stop();
    this.recorder = null;
    void this.audioContext?.close();
    this.audioContext = null;
    void this.send?.({ type: "recording", on: false });
    this.changed();
  }

  async disableRecording() {
    if (!this.isHost) return;
    await ConnectEngine.supabase.rpc("prosm_time_connect_set_recording", { p_meeting: this.meetingId, p_allowed: false });
    this.recordingAllowed = false;
    void this.send?.({ type: "recording-off" });
    if (this.recording) this.stopRecording();
    this.changed();
  }

  private async sampleQuality() {
    for (const [userId, guard] of this.guards) {
      const q = await guard.sample().catch(() => null);
      const peer = this.peers.get(userId);
      if (peer && q) peer.level = q.level;
    }
    this.changed();
  }

  /** Is the connection weak overall? (the screen then suggests sound only) */
  get weak() {
    const levels = [...this.peers.values()].map((p) => p.level).filter((l) => l > 0);
    return levels.length > 0 && Math.min(...levels) <= 1;
  }

  private drop(userId: string) {
    this.connections.get(userId)?.close();
    this.connections.delete(userId);
    this.guards.delete(userId);
    this.peers.delete(userId);
    if (this.sharingBy === userId) this.sharingBy = null;
    if (this.pinned === userId) this.pinned = null;
  }

  async leave() {
    if (this.isHost) {
      await ConnectEngine.supabase.rpc("prosm_time_connect_end_meeting", { p_meeting: this.meetingId }).then(() => this.send?.({ type: "end" }));
    } else {
      await ConnectEngine.supabase.rpc("prosm_time_connect_leave_meeting", { p_meeting: this.meetingId });
    }
    this.close(true);
  }

  close(left: boolean) {
    if (this.ended) return;
    this.ended = true;
    if (this.recording) this.stopRecording();
    if (!left) void ConnectEngine.supabase.rpc("prosm_time_connect_leave_meeting", { p_meeting: this.meetingId });
    this.timers.forEach((t) => window.clearInterval(t));
    for (const pc of this.connections.values()) pc.close();
    this.connections.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    if (this.channel) void ConnectEngine.supabase.removeChannel(this.channel);
    this.channel = null;
    this.changed();
  }
}

function blankPeer(userId: string): Peer {
  return { userId, stream: new MediaStream(), muted: false, videoOff: false, hand: false, recording: false, level: 0, speaking: false };
}
