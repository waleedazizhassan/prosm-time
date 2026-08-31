import { useEffect, useState, type ChangeEvent } from "react";
import FormField from "./FormField";
import styles from "./Input.module.css";

interface EvidenceCaptureFieldProps {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
}

// PROSM Time WP-08/§16 - "Open camera capture from supported device/
// browser." A native file input with capture="environment" opens the
// device camera directly on a phone/tablet browser (and falls back to
// a normal file picker elsewhere) - a real, functional capture entry
// point without a custom live-preview widget, which is visual/UX
// polish explicitly deferred for now. The selected file is only ever
// held in memory here; EvidenceRepository.uploadEvidence() is what
// actually uploads it, after the attendance event it will be linked to
// exists.
export default function EvidenceCaptureField({ label, file, onChange, required = false, disabled = false, helperText }: EvidenceCaptureFieldProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.files?.[0] ?? null);
  };

  return (
    <FormField label={label} htmlFor="evidenceCapture" required={required} helperText={helperText}>
      <input id="evidenceCapture" name="evidenceCapture" type="file" accept="image/*" capture="environment" onChange={handleChange} disabled={disabled} className={styles.input} style={{ padding: "var(--space-2)" }} />
      {previewUrl ? <img src={previewUrl} alt="" style={{ marginTop: "var(--space-2)", maxWidth: "120px", maxHeight: "120px", borderRadius: "var(--radius-sm)", objectFit: "cover" }} /> : null}
    </FormField>
  );
}
