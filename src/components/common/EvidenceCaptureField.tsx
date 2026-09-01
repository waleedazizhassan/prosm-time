import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Camera } from "lucide-react";

import FormField from "./FormField";
import Button from "./Button";
import CameraCaptureModal from "./CameraCaptureModal";
import styles from "./EvidenceCaptureField.module.css";

interface EvidenceCaptureFieldProps {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
}

// PROSM Time WP-08/§16 - "Open camera capture from supported device/
// browser." § final visual consistency pass, user-directed: "open the
// device/browser camera directly... do not present a generic file-
// upload picker as the primary flow. Flow: Open Camera -> Capture ->
// Preview -> Retake / Use Photo -> Upload." CameraCaptureModal is that
// real flow now; a plain file picker remains available only as a
// secondary fallback (camera permission denied, no camera hardware,
// unsupported browser) so evidence capture is never a hard dead end.
// The selected/captured file is only ever held in memory here -
// EvidenceRepository.uploadEvidence() is what actually uploads it,
// after the attendance event it will be linked to exists - entirely
// unchanged.
export default function EvidenceCaptureField({ label, file, onChange, required = false, disabled = false, helperText }: EvidenceCaptureFieldProps) {
  const { t } = useTranslation("camera");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.files?.[0] ?? null);
  };

  const handleCapture = (capturedFile: File) => {
    onChange(capturedFile);
  };

  return (
    <FormField label={label} htmlFor="evidenceCapture" required={required} helperText={helperText}>
      {previewUrl ? (
        <div className={styles.previewRow}>
          <img src={previewUrl} alt={t("previewAlt")} className={styles.previewImage} />
          <Button type="button" variant="ghost" size="sm" onClick={() => setCameraOpen(true)} disabled={disabled}>
            <Camera size={14} /> {t("retake")}
          </Button>
        </div>
      ) : (
        <div className={styles.actionsRow}>
          <Button type="button" onClick={() => setCameraOpen(true)} disabled={disabled}>
            <Camera size={16} /> {t("openCameraAction")}
          </Button>
          <button type="button" className={styles.fallbackLink} onClick={() => fileInputRef.current?.click()} disabled={disabled}>
            {t("chooseFileAction")}
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        id="evidenceCapture"
        name="evidenceCapture"
        type="file"
        accept="image/*"
        onChange={handleFileInputChange}
        disabled={disabled}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
      />

      <CameraCaptureModal isOpen={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleCapture} />
    </FormField>
  );
}
