import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Camera, RefreshCw, Upload, X, SwitchCamera } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import { LivenessGate } from "../../core/utils/livenessCheck";
import DatabaseManager from "../../core/database/DatabaseManager";
import { runLivenessChallenge, tagCapture, type LivenessChallenge, type LivenessResult } from "../../core/utils/captureIntegrity";
import styles from "./CameraCaptureModal.module.css";

// Low-res sampling for the liveness check below - a full-resolution frame
// diff would be needlessly slow for a signal this coarse (real vs. a
// perfectly static image), and a small canvas still carries plenty of
// pixel variance to detect real camera motion.
const LIVENESS_SAMPLE_SIZE = 24;
const LIVENESS_SAMPLE_INTERVAL_MS = 250;

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  // v2.3.43 step 11: the site of the clock in/out (the server decides the liveness challenge from it).
  siteId?: string | null;
}

interface CaptureToken {
  token: string;
  challengeRequired: boolean;
  challenge: LivenessChallenge | null;
}

const MAX_CHALLENGE_ATTEMPTS = 3;

type FacingMode = "environment" | "user";

// § live UX review, user-directed - "the rear camera doesn't reliably
// open on mobile" (originally rear-only), then "the front camera
// doesn't work at all, there should be a button to switch between
// them" - this now opens whichever facing mode is requested. A plain
// (non-exact) facingMode constraint is only a preference - some
// Android WebViews still hand back the wrong camera under it. Try the
// authoritative `exact` form first; only a device with a single,
// unlabeled camera throws OverconstrainedError for that, so fall back
// to the plain ideal constraint in that one case.
async function openCamera(facingMode: FacingMode): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facingMode } } });
  } catch (error) {
    if (error instanceof Error && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode } });
    }
    throw error;
  }
}

// PROSM Time - mirrors PROSM Platform's own CameraCaptureModal (§ final
// visual consistency pass, correction: "Clock In / Clock Out must be
// the single primary attendance action... Camera is part of the
// attendance flow, not a standalone feature/button"). This modal is
// never opened by its own dedicated button anymore - the caller
// (ClockInOutCard / KioskPage) opens it automatically the instant the
// employee taps Clock In/Out on a site that requires evidence, as one
// continuous action: Clock In/Out tap -> Camera Opens -> Capture ->
// Preview -> Use Photo -> the attendance action completes immediately
// with that file. onCapture fires exactly once, only from "Use Photo"
// (or the fallback file input below). A captured frame becomes an
// ordinary File (canvas.toBlob), so it re-enters the exact same
// EvidenceRepository.uploadEvidence() pipeline an uploaded photo
// already used - no separate architecture for camera capture, and the
// private-storage/RLS/retention/audit backend behind it (WP-08) is
// entirely unchanged. A real file-picker fallback lives here too (not
// a separate always-visible button) - reachable only once getUserMedia
// has actually failed, so evidence capture is never a hard dead end
// even without a standalone Camera control anywhere in the UI.
export default function CameraCaptureModal({ isOpen, onClose, onCapture, siteId = null }: CameraCaptureModalProps) {
  const { t } = useTranslation("camera");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  // § real gap fix, 14-point live-audit - no liveness signal existed at
  // all, so a printed/screenshotted photo held up to the camera captured
  // identically to a real live face. See livenessCheck.ts's own header
  // for exactly what this does and does not defend against.
  const [livenessReady, setLivenessReady] = useState(false);
  const livenessGateRef = useRef<LivenessGate | null>(null);
  const livenessCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // § live UX review, user-directed - "the front camera doesn't work,
  // there should be a button to switch between them," then "the front
  // camera should be the one active by default for clock-in/out" -
  // matches this modal's own face-based-identification framing (see
  // the CSS's own header comment); the switch button still reaches the
  // rear camera when needed.
  const [facingMode, setFacingMode] = useState<FacingMode>("user");

  // v2.3.43 step 11 (item 22): a one-time token from the server for this
  // photo, and - when the site asks for it - a short movement the person
  // makes in front of the camera (checked here, on the device).
  const [captureToken, setCaptureToken] = useState<CaptureToken | null>(null);
  const [challengeState, setChallengeState] = useState<"idle" | "running" | "passed" | "failed" | "unavailable">("idle");
  const [challengeAttempts, setChallengeAttempts] = useState(0);
  const [challengeResult, setChallengeResult] = useState<{ result: LivenessResult; confidence: number | null }>({ result: "not_required", confidence: null });
  const challengeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen) {
      challengeAbortRef.current?.abort();
      setCaptureToken(null);
      setChallengeState("idle");
      setChallengeAttempts(0);
      setChallengeResult({ result: "not_required", confidence: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await DatabaseManager.getClient().rpc("issue_prosm_time_capture_token", { p_site_id: siteId });
        if (!cancelled && !error && data) setCaptureToken(data as CaptureToken);
      } catch {
        // offline: no token - the photo is still taken and the server flags it for review
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, siteId]);

  const runChallenge = async () => {
    const video = videoRef.current;
    if (!video || !captureToken?.challenge) return;
    challengeAbortRef.current?.abort();
    const controller = new AbortController();
    challengeAbortRef.current = controller;
    setChallengeState("running");
    const outcome = await runLivenessChallenge(video, captureToken.challenge, facingMode === "user", controller.signal);
    if (controller.signal.aborted) return;
    setChallengeAttempts((count) => count + 1);
    setChallengeResult(outcome);
    setChallengeState(outcome.result);
  };

  const challengePending =
    Boolean(captureToken?.challengeRequired) && challengeState !== "passed" && challengeState !== "unavailable" && challengeAttempts < MAX_CHALLENGE_ATTEMPTS;

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    if (!isOpen) {
      stopStream();
      setCapturedDataUrl(null);
      setError("");
      // § real bug, live-tested: this reset still targeted the OLD
      // default ("environment") after the default was changed to
      // "user" - so the very first close (any clock-in/out) flipped
      // it to the back camera and it stayed there from then on.
      setFacingMode("user");
      return undefined;
    }

    let cancelled = false;
    livenessGateRef.current = new LivenessGate();
    setLivenessReady(false);

    openCamera(facingMode)
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        if (!cancelled) setError(t("permissionDenied"));
      });

    const sampleInterval = window.setInterval(() => {
      const video = videoRef.current;
      const gate = livenessGateRef.current;
      if (!video || !gate || !video.videoWidth || video.paused) return;

      if (!livenessCanvasRef.current) livenessCanvasRef.current = document.createElement("canvas");
      const canvas = livenessCanvasRef.current;
      canvas.width = LIVENESS_SAMPLE_SIZE;
      canvas.height = LIVENESS_SAMPLE_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, LIVENESS_SAMPLE_SIZE, LIVENESS_SAMPLE_SIZE);
      const { data } = ctx.getImageData(0, 0, LIVENESS_SAMPLE_SIZE, LIVENESS_SAMPLE_SIZE);
      gate.addSample(data);
      if (gate.ready) setLivenessReady(true);
    }, LIVENESS_SAMPLE_INTERVAL_MS);

    // No camera stream may remain active after cancel/close/unmount, or
    // before re-opening on the newly selected facing mode.
    return () => {
      cancelled = true;
      window.clearInterval(sampleInterval);
      stopStream();
    };
  }, [isOpen, facingMode, t]);

  const handleSwitchCamera = () => {
    setError("");
    setFacingMode((current) => (current === "environment" ? "user" : "environment"));
  };

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    setCapturedDataUrl(canvas.toDataURL("image/jpeg", 0.9));
    // Freeze the preview by stopping the live stream now - the user is
    // reviewing a still frame, not a live feed, from this point on.
    stopStream();
  };

  const handleRetake = () => {
    setCapturedDataUrl(null);
    livenessGateRef.current = new LivenessGate();
    setLivenessReady(false);
    if (isOpen) {
      openCamera(facingMode)
        .then((stream) => {
          streamRef.current = stream;
          if (videoRef.current) videoRef.current.srcObject = stream;
        })
        .catch(() => setError(t("permissionDenied")));
    }
  };

  const handleConfirm = async () => {
    if (!capturedDataUrl) return;
    const response = await fetch(capturedDataUrl);
    const blob = await response.blob();
    const file = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: "image/jpeg" });
    tagCapture(file, {
      token: captureToken?.token ?? null,
      captureSource: "live_camera",
      livenessResult: captureToken?.challengeRequired ? challengeResult.result : "not_required",
      challenge: captureToken?.challenge ?? null,
      confidence: challengeResult.confidence,
    });
    onCapture(file);
    onClose();
  };

  // Real fallback for the "never a hard dead end" promise (see file
  // header) - reachable only once getUserMedia has already failed
  // (denied permission, no camera hardware, unsupported browser), so
  // it never competes with Capture as a second primary path.
  const handleFileFallback = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // Not from the live camera: kept, and marked for a manager to review.
    tagCapture(file, {
      token: captureToken?.token ?? null,
      captureSource: "file_fallback",
      livenessResult: captureToken?.challengeRequired ? "unavailable" : "not_required",
      challenge: captureToken?.challenge ?? null,
      confidence: null,
    });
    onCapture(file);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("title")}
      size="md"
      footer={
        capturedDataUrl ? (
          <>
            <Button variant="ghost" onClick={handleRetake}>
              <RefreshCw size={14} /> {t("retake")}
            </Button>
            <Button variant="primary" onClick={handleConfirm}>
              {t("usePhoto")}
            </Button>
          </>
        ) : error ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} /> {t("chooseFileAction")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            {challengePending ? (
              <Button variant="primary" onClick={runChallenge} loading={challengeState === "running"}>
                {challengeAttempts === 0 ? t("challenge.start") : t("challenge.retry")}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleCapture} disabled={!livenessReady}>
                <Camera size={14} /> {t("capture")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className={styles.viewport}>
        {error ? (
          <div className={styles.errorState}>
            <X size={22} />
            <p>{error}</p>
            <p className={styles.errorHint}>{t("alternativeHint")}</p>
          </div>
        ) : capturedDataUrl ? (
          <img src={capturedDataUrl} alt={t("previewAlt")} className={styles.preview} />
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted className={`${styles.video} ${facingMode === "user" ? styles.videoMirrored : ""}`} />
            <div className={styles.faceGuide} aria-hidden="true" />
            {captureToken?.challengeRequired && captureToken.challenge ? (
              <div className={styles.livenessHint} aria-live="polite">
                {challengeState === "passed"
                  ? t("challenge.passed")
                  : challengeState === "unavailable"
                  ? t("challenge.unavailable")
                  : challengeState === "failed"
                  ? challengeAttempts >= MAX_CHALLENGE_ATTEMPTS
                    ? t("challenge.failedFinal")
                    : t("challenge.failed", { left: MAX_CHALLENGE_ATTEMPTS - challengeAttempts })
                  : t(`challenge.instruction.${captureToken.challenge}`)}
              </div>
            ) : !livenessReady ? (
              <div className={styles.livenessHint} aria-live="polite">
                {t("verifyingLiveness")}
              </div>
            ) : null}
            <button type="button" className={styles.switchCameraButton} onClick={handleSwitchCamera} aria-label={t("switchCamera")} title={t("switchCamera")}>
              <SwitchCamera size={18} />
            </button>
          </>
        )}
      </div>

      {captureToken?.challengeRequired ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("challenge.privacy")}</p> : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="user"
        onChange={handleFileFallback}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </Modal>
  );
}
