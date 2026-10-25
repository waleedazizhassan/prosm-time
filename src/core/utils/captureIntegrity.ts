// v2.3.43 step 11 (item 22): how an evidence photo was captured travels with
// the File from the camera to the upload (EvidenceRepository reports it to the
// server after attaching the photo). A photo queued offline loses it on
// purpose: its token would be stale anyway, and offline time has its own review.

export type LivenessChallenge = "turn_left" | "turn_right" | "move_closer";
export type LivenessResult = "passed" | "failed" | "unavailable" | "not_required";

export interface CaptureIntegrity {
  token: string | null;
  captureSource: "live_camera" | "file_fallback";
  livenessResult: LivenessResult;
  challenge: LivenessChallenge | null;
  confidence: number | null;
}

const byFile = new WeakMap<File, CaptureIntegrity>();

export function tagCapture(file: File, integrity: CaptureIntegrity): File {
  byFile.set(file, integrity);
  return file;
}

export function captureIntegrityOf(file: File): CaptureIntegrity | null {
  return byFile.get(file) ?? null;
}

// ---------------------------------------------------------------------------
// The challenge, checked on the device only (no video leaves the phone, no
// face template is kept). Uses the browser's FaceDetector (Shape Detection
// API) where the device has it; elsewhere the result is "unavailable" and the
// check-in goes on with that mark - it is never blocked.
// ---------------------------------------------------------------------------

interface DetectedFace {
  boundingBox: DOMRectReadOnly;
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedFace[]>;
}
type FaceDetectorCtor = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

export function faceDetectorAvailable(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { FaceDetector?: FaceDetectorCtor }).FaceDetector === "function";
}

export const CHALLENGE_TIMEOUT_MS = 8000;

// Watches the live video for the asked movement. `mirrored`: the front camera
// preview is mirrored, so "turn left" moves the face to the right of the frame.
export async function runLivenessChallenge(
  video: HTMLVideoElement,
  challenge: LivenessChallenge,
  mirrored: boolean,
  signal: AbortSignal,
): Promise<{ result: Exclude<LivenessResult, "not_required">; confidence: number | null }> {
  const Ctor = (window as unknown as { FaceDetector?: FaceDetectorCtor }).FaceDetector;
  if (!Ctor) return { result: "unavailable", confidence: null };
  let detector: FaceDetectorLike;
  try {
    detector = new Ctor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return { result: "unavailable", confidence: null };
  }

  const started = Date.now();
  let baseline: DOMRectReadOnly | null = null;
  let best = 0;
  while (Date.now() - started < CHALLENGE_TIMEOUT_MS && !signal.aborted) {
    let faces: DetectedFace[] = [];
    try {
      faces = await detector.detect(video);
    } catch {
      return { result: "unavailable", confidence: null };
    }
    const box = faces[0]?.boundingBox;
    if (box && video.videoWidth) {
      if (!baseline) baseline = box;
      const width = video.videoWidth;
      const shift = (box.x + box.width / 2 - (baseline.x + baseline.width / 2)) / width;
      const growth = box.width / baseline.width - 1;
      // A face turning left moves toward the frame's right on the camera image
      // (the preview is mirrored for the front camera).
      const toward = mirrored ? 1 : -1;
      const progress =
        challenge === "move_closer" ? growth / 0.25 : challenge === "turn_left" ? (toward * shift) / 0.12 : (-toward * shift) / 0.12;
      best = Math.max(best, progress);
      if (progress >= 1) return { result: "passed", confidence: Math.min(1, progress / 1.5) };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { result: "failed", confidence: Math.max(0, Math.min(1, best)) };
}
