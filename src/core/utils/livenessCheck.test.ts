import { describe, expect, it, vi } from "vitest";

import { LivenessGate, meanAbsoluteDifference } from "./livenessCheck";

function frame(fill: number, length = 40): Uint8ClampedArray {
  return new Uint8ClampedArray(length).fill(fill);
}

describe("meanAbsoluteDifference", () => {
  it("is zero for identical frames", () => {
    expect(meanAbsoluteDifference(frame(120), frame(120))).toBe(0);
  });

  it("reflects the real per-channel gap for different frames", () => {
    expect(meanAbsoluteDifference(frame(100), frame(110))).toBe(10);
  });

  it("returns zero for mismatched-length buffers rather than throwing", () => {
    expect(meanAbsoluteDifference(frame(100, 10), frame(100, 20))).toBe(0);
  });
});

describe("LivenessGate", () => {
  it("is not ready after a single sample (nothing to compare yet)", () => {
    const gate = new LivenessGate();
    gate.addSample(frame(100));
    expect(gate.ready).toBe(false);
  });

  it("becomes ready once real motion crosses the threshold - a static photo held to the camera never would", () => {
    const gate = new LivenessGate({ motionThreshold: 2.5, graceTimeoutMs: 60_000 });
    gate.addSample(frame(100));
    // Static image: every later sample is byte-identical - should never
    // trip motionObserved (this is exactly what this check is FOR).
    gate.addSample(frame(100));
    gate.addSample(frame(100));
    expect(gate.ready).toBe(false);

    // A real camera's natural micro-motion crosses the threshold.
    gate.addSample(frame(106));
    expect(gate.ready).toBe(true);
  });

  it("falls back to ready once the grace timeout elapses, even with zero motion - never a hard dead end", () => {
    vi.useFakeTimers();
    try {
      const gate = new LivenessGate({ motionThreshold: 2.5, graceTimeoutMs: 1000 });
      gate.addSample(frame(100));
      expect(gate.ready).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(gate.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
