import { Capacitor, registerPlugin } from "@capacitor/core";

// PROSM Connect - the sounds (owner 2026-11-14: "the ringtone keeps going like a normal phone ring, full - and settings
// for the sound and the vibration"). An incoming call rings with the chosen tone, again and again, until it is
// answered, declined or given up (45 seconds); the caller hears the ring-back tone while the other phone rings. Every
// cycle is put on the sound card's own clock at once, so a tab in the background keeps ringing. The settings stay on
// this device; the Android app also gets them, for the ringing it does itself when the app is closed or the screen
// locked (there it rings with the phone's own ringtone).

export type RingTone = "classic" | "digital" | "marimba";
export interface SoundPrefs {
  tone: RingTone;
  volume: number; // 0..1
  callVibrate: boolean;
  messageSound: boolean;
  messageVibrate: boolean;
}

const KEY = "prosm_connect_sounds";
const DEFAULTS: SoundPrefs = { tone: "classic", volume: 0.8, callVibrate: true, messageSound: true, messageVibrate: true };
export const RING_TONES: RingTone[] = ["classic", "digital", "marimba"];
const RING_FOR_S = 45;

interface ConnectSoundPlugin {
  setConnectSound(options: { sound: boolean; vibrate: boolean }): Promise<void>;
}
const Native = registerPlugin<ConnectSoundPlugin>("ShiftTracking");

export function loadSoundPrefs(): SoundPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SoundPrefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSoundPrefs(prefs: SoundPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // private window: the choice lasts for this visit
  }
  // the Android app rings by itself when closed (an older build has no such call - nothing happens)
  if (Capacitor.isNativePlatform()) void Native.setConnectSound({ sound: prefs.volume > 0, vibrate: prefs.callVibrate }).catch(() => undefined);
}

type Ctx = AudioContext;

function tone(ctx: Ctx, out: AudioNode, freq: number, at: number, length: number, type: OscillatorType = "sine", level = 1, decay = false) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(level, at + 0.01);
  if (decay) gain.gain.exponentialRampToValueAtTime(0.001, at + length);
  else {
    gain.gain.setValueAtTime(level, at + length - 0.02);
    gain.gain.linearRampToValueAtTime(0, at + length);
  }
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

/** A bell's burst: a double tone trembling 20 times a second. */
function trill(ctx: Ctx, out: AudioNode, at: number, length: number) {
  const bell = ctx.createGain();
  bell.gain.value = 0;
  const lfo = ctx.createOscillator();
  lfo.type = "square";
  lfo.frequency.value = 20;
  const depth = ctx.createGain();
  depth.gain.value = 0.25;
  lfo.connect(depth).connect(bell.gain);
  bell.gain.setValueAtTime(0.25, at);
  bell.gain.setValueAtTime(0, at + length);
  for (const [freq, level] of [[1150, 0.55], [1450, 0.4]] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    g.gain.value = level;
    osc.connect(g).connect(bell);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }
  bell.connect(out);
  lfo.start(at);
  lfo.stop(at + length + 0.02);
}

/** One ring of a tone, starting at `at`; returns how long the ring with its pause lasts. */
function ringCycle(ctx: Ctx, out: AudioNode, kind: RingTone, at: number): number {
  if (kind === "classic") {
    // the bell of a desk phone: two bursts of a trembling double tone, then a pause
    for (const start of [0, 0.6]) trill(ctx, out, at + start, 0.42);
    return 3;
  }
  if (kind === "digital") {
    for (let i = 0; i < 8; i += 1) tone(ctx, out, i % 2 ? 1180 : 880, at + i * 0.13, 0.11, "square", 0.18);
    tone(ctx, out, 1320, at + 1.15, 0.25, "square", 0.18);
    return 2.6;
  }
  // marimba: a short rising tune
  const notes = [659.3, 784, 987.8, 1318.5, 987.8, 1174.7];
  notes.forEach((f, i) => tone(ctx, out, f, at + i * 0.16, 0.45, "triangle", 0.7, true));
  return 2.4;
}

function start(build: (ctx: Ctx, out: GainNode) => void, volume: number): () => void {
  let ctx: Ctx | null = null;
  try {
    ctx = new AudioContext();
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(ctx.destination);
    void ctx.resume().catch(() => undefined);
    build(ctx, out);
  } catch {
    // no sound card or not allowed yet
  }
  return () => {
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    ctx = null;
  };
}

/** The incoming call rings (and vibrates) until the returned function is called. */
export function startRingtone(prefs = loadSoundPrefs()): () => void {
  const stopSound = prefs.volume > 0
    ? start((ctx, out) => {
        let at = ctx.currentTime + 0.05;
        while (at < ctx.currentTime + RING_FOR_S) at += ringCycle(ctx, out, prefs.tone, at);
      }, prefs.volume)
    : () => undefined;
  if (prefs.callVibrate && "vibrate" in navigator) {
    const pattern: number[] = [];
    for (let s = 0; s < RING_FOR_S; s += 2.6) pattern.push(1000, 1600);
    navigator.vibrate(pattern);
  }
  return () => {
    stopSound();
    if ("vibrate" in navigator) navigator.vibrate(0);
  };
}

/** A sample of a tone in the settings (one ring). */
export function previewTone(kind: RingTone, volume: number): () => void {
  return start((ctx, out) => void ringCycle(ctx, out, kind, ctx.currentTime + 0.05), volume);
}

/** The caller hears the other phone ringing: 425 Hz, two seconds on, one off (as on a phone line here). */
export function startRingback(prefs = loadSoundPrefs()): () => void {
  if (prefs.volume === 0) return () => undefined;
  return start((ctx, out) => {
    for (let at = ctx.currentTime + 0.05; at < ctx.currentTime + RING_FOR_S; at += 3) tone(ctx, out, 425, at, 2, "sine", 0.22);
  }, Math.min(1, prefs.volume + 0.1));
}

/** A new message while the app is open: a short chime and/or a short vibration, as chosen. */
export function messageAlert(prefs = loadSoundPrefs()) {
  if (prefs.messageSound && prefs.volume > 0) {
    const stop = start((ctx, out) => {
      tone(ctx, out, 880, ctx.currentTime + 0.02, 0.18, "sine", 0.35, true);
      tone(ctx, out, 1318.5, ctx.currentTime + 0.14, 0.3, "sine", 0.3, true);
    }, prefs.volume);
    window.setTimeout(stop, 800);
  }
  if (prefs.messageVibrate && "vibrate" in navigator) navigator.vibrate([60, 60, 60]);
}
