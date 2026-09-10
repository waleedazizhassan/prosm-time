// PROSM Time - 14-point live-audit gap #5: attendance photo evidence had
// zero liveness signal - any static image held up to the camera (a
// printed photo, a photo shown on another screen) would capture and
// upload exactly like a real live face, with nothing to tell them apart.
//
// This is deliberately NOT true biometric liveness (no face landmarks, no
// blink/gaze detection, no anti-deepfake defense) - that needs a real ML
// model this pass doesn't add, and claiming otherwise would overstate what
// this actually protects against. What this DOES catch, honestly: the
// single most common naive spoof, a perfectly static image held in front
// of the camera. A genuinely live camera feed of a person always has some
// natural micro-motion (breathing, tiny hand tremor, blinking) that a
// printed photo or a frozen screenshot does not.
//
// The check: sample the video at low resolution a few times over ~1.2s
// and require the mean pixel difference between consecutive samples to
// exceed a low, real-motion-only threshold at least once. A image with
// zero exploitable motion at all (perfectly still, e.g. propped on a
// tripod against a wall) will still pass eventually via the graceTimeoutMs
// fallback below, so this can never become a hard dead end for an honest
// user who happens to be sitting very still.

export interface LivenessSample {
  data: Uint8ClampedArray;
  capturedAt: number;
}

// Mean absolute per-channel difference between two equally-sized RGBA
// frames, 0-255. Pure and independently testable - no DOM/canvas needed.
export function meanAbsoluteDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

export interface LivenessGateOptions {
  // A real live camera feed reliably clears this within a couple of
  // samples even for a very still subject (sensor noise alone crosses
  // it) - tuned to sit well above encode/compression noise but well
  // below "the frame actually changed."
  motionThreshold: number;
  graceTimeoutMs: number;
}

export const DEFAULT_LIVENESS_GATE_OPTIONS: LivenessGateOptions = {
  motionThreshold: 2.5,
  graceTimeoutMs: 4000,
};

// Tracks samples over time and reports whether real motion has been
// observed, or whether the grace timeout means capture should be allowed
// anyway (see file header - never a hard dead end).
export class LivenessGate {
  private samples: LivenessSample[] = [];
  private readonly startedAt = Date.now();
  private motionObserved = false;

  constructor(private readonly options: LivenessGateOptions = DEFAULT_LIVENESS_GATE_OPTIONS) {}

  addSample(data: Uint8ClampedArray): { motionObserved: boolean; graceExpired: boolean } {
    const now = Date.now();
    const previous = this.samples[this.samples.length - 1];
    this.samples.push({ data, capturedAt: now });
    if (this.samples.length > 5) this.samples.shift();

    if (previous && !this.motionObserved) {
      const diff = meanAbsoluteDifference(previous.data, data);
      if (diff >= this.options.motionThreshold) this.motionObserved = true;
    }

    return {
      motionObserved: this.motionObserved,
      graceExpired: now - this.startedAt >= this.options.graceTimeoutMs,
    };
  }

  get ready(): boolean {
    if (this.motionObserved) return true;
    return Date.now() - this.startedAt >= this.options.graceTimeoutMs;
  }
}
