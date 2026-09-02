import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Camera, RefreshCw, Upload, X } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import styles from "./CameraCaptureModal.module.css";

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
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

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    if (!isOpen) {
      stopStream();
      setCapturedDataUrl(null);
      setError("");
      return undefined;
    }

    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
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

    // No camera stream may remain active after cancel/close/unmount.
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [isOpen, t]);

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
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
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
            <video ref={videoRef} autoPlay playsInline muted className={styles.video} />
            <div className={styles.faceGuide} aria-hidden="true" />
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
