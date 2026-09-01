import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, RefreshCw, X } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import styles from "./CameraCaptureModal.module.css";

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
}

// PROSM Time - mirrors PROSM Platform's own CameraCaptureModal exactly
// (§ final visual consistency pass, user-directed: "open the device/
// browser camera directly... do not present a generic file-upload
// picker as the primary flow"). Real flow: User Action -> Camera
// Permission -> Camera Opens -> User Captures -> Preview -> User
// Confirms -> File handed to the caller. The camera never opens until
// this modal is explicitly opened, and a captured frame is never
// handed back until the user's own explicit "Use Photo" click -
// onCapture fires exactly once, only from that button. A captured
// frame becomes an ordinary File (canvas.toBlob), so it re-enters the
// exact same EvidenceRepository.uploadEvidence() pipeline an uploaded
// photo already used - no separate architecture for camera capture,
// and the private-storage/RLS/retention/audit backend behind it (WP-08)
// is entirely unchanged.
export default function CameraCaptureModal({ isOpen, onClose, onCapture }: CameraCaptureModalProps) {
  const { t } = useTranslation("camera");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
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
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" onClick={handleCapture} disabled={Boolean(error)}>
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
          <video ref={videoRef} autoPlay playsInline muted className={styles.video} />
        )}
      </div>
    </Modal>
  );
}
