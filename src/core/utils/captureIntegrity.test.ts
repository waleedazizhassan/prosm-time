// v2.3.43 step 11: the on-device liveness challenge.
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureIntegrityOf, runLivenessChallenge, tagCapture } from "./captureIntegrity";

type Box = { x: number; y: number; width: number; height: number };

function installDetector(boxes: Box[]) {
  let call = 0;
  (window as unknown as { FaceDetector: unknown }).FaceDetector = class {
    async detect() {
      const box = boxes[Math.min(call, boxes.length - 1)];
      call += 1;
      return [{ boundingBox: box as DOMRectReadOnly }];
    }
  };
}

const video = { videoWidth: 640 } as HTMLVideoElement;

afterEach(() => {
  delete (window as unknown as { FaceDetector?: unknown }).FaceDetector;
  vi.useRealTimers();
});

describe("liveness challenge", () => {
  it("is unavailable without a face detector on the device", async () => {
    expect((await runLivenessChallenge(video, "turn_left", true, new AbortController().signal)).result).toBe("unavailable");
  });

  it("passes when the face moves the asked way (front camera, mirrored)", async () => {
    installDetector([
      { x: 200, y: 100, width: 200, height: 200 },
      { x: 320, y: 100, width: 200, height: 200 },
    ]);
    const outcome = await runLivenessChallenge(video, "turn_left", true, new AbortController().signal);
    expect(outcome.result).toBe("passed");
  });

  it("passes 'move closer' when the face grows", async () => {
    installDetector([
      { x: 200, y: 100, width: 200, height: 200 },
      { x: 170, y: 80, width: 270, height: 270 },
    ]);
    expect((await runLivenessChallenge(video, "move_closer", true, new AbortController().signal)).result).toBe("passed");
  });

  it("fails after the time limit when the face does not move (a still photo)", async () => {
    vi.useFakeTimers();
    installDetector([{ x: 200, y: 100, width: 200, height: 200 }]);
    const pending = runLivenessChallenge(video, "turn_right", true, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9000);
    expect((await pending).result).toBe("failed");
  });

  it("the capture record travels with the photo", () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    tagCapture(file, { token: "t", captureSource: "live_camera", livenessResult: "passed", challenge: "turn_left", confidence: 0.8 });
    expect(captureIntegrityOf(file)?.livenessResult).toBe("passed");
    expect(captureIntegrityOf(new File(["y"], "b.jpg"))).toBeNull();
  });
});
