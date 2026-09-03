import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Camera, RefreshCw, Upload, X, SwitchCamera } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import styles from "./CameraCaptureModal.module.css";

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
}

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
export default function CameraCaptureModal({ isOpen, onClose, onCapture }: CameraCaptureModalProps) {
  const { t } = useTranslation("camera");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  // § live UX review, user-directed - "the front camera doesn't work,
  // there should be a button to switch between them," then "the front
  // camera should be the one active by default for clock-in/out" -
  // matches this modal's own face-based-identification framing (see
  // the CSS's own header comment); the switch button still reaches the
  // rear camera when needed.
  const [facingMode, setFacingMode] = useState<FacingMode>("user");

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

    // No camera stream may remain active after cancel/close/unmount, or
    // before re-opening on the newly selected facing mode.
    return () => {
      cancelled = true;
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
            <Button variant="primary" onClick={handleCapture}>
              <Camera size={14} /> {t("capture")}
            </Button>
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
            <button type="button" className={styles.switchCameraButton} onClick={handleSwitchCamera} aria-label={t("switchCamera")} title={t("switchCamera")}>
              <SwitchCamera size={18} />
            </button>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileFallback}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </Modal>
  );
}
