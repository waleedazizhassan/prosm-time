import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import Textarea from "./Textarea";
import ErrorText from "./ErrorText";
import { formatTimeOnly } from "../../core/utils/formatDate";

interface AttendanceConfirmModalProps {
  isOpen: boolean;
  action: "clockIn" | "clockOut";
  photoPreviewUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  placeName: string | null;
  siteName: string;
  submitting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (note: string, activity: string) => void;
}

// PROSM Time - § live UX review, user-directed: a real confirmation
// screen shown right before every clock-in/out actually submits - not
// just when a photo was captured (that stays step 2, unchanged) - so
// the employee sees exactly what's about to be recorded (photo if any,
// GPS detail, site/workplace, time) and can add an optional note or
// describe what they're working on before it's final. Purely
// presentational - the location shown is the same live currentLocation/
// placeName ClockInOutCard already tracks for display, and the actual
// submitted coordinates are still a fresh, independent capture taken
// at the moment of the real performClockIn/performClockOut call
// (unchanged - see that function's own header comment).
export default function AttendanceConfirmModal({
  isOpen,
  action,
  photoPreviewUrl,
  latitude,
  longitude,
  accuracyMeters,
  placeName,
  siteName,
  submitting,
  error,
  onCancel,
  onConfirm,
}: AttendanceConfirmModalProps) {
  const { t, i18n } = useTranslation("dashboard");
  const [note, setNote] = useState("");
  const [activity, setActivity] = useState("");

  useEffect(() => {
    if (isOpen) {
      setNote("");
      setActivity("");
    }
  }, [isOpen]);

  const mapsUrl = latitude !== null && longitude !== null ? `https://www.google.com/maps?q=${latitude},${longitude}` : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t(action === "clockIn" ? "attendance.confirmClockInTitle" : "attendance.confirmClockOutTitle")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onConfirm(note, activity)} loading={submitting}>
            {t(action === "clockIn" ? "attendance.clockInAction" : "attendance.clockOutAction")}
          </Button>
        </>
      }
    >
      {photoPreviewUrl ? (
        <img
          src={photoPreviewUrl}
          alt={t("attendance.confirmPhotoLabel")}
          style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: "var(--radius-md)", marginBottom: "var(--space-3)" }}
        />
      ) : (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>{t("attendance.confirmNoPhoto")}</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginBottom: "var(--space-4)", fontSize: "var(--font-sm)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.siteLabel")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", textAlign: "end" }}>{siteName}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.confirmTimeLabel")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)" }}>{formatTimeOnly(new Date().toISOString(), i18n.language)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)" }}>
          <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>{t("attendance.confirmLocationLabel")}</span>
          {latitude !== null && longitude !== null ? (
            <span style={{ textAlign: "end" }}>
              {mapsUrl ? (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: "2px", color: "var(--text-link)", textDecoration: "none" }}
                >
                  <MapPin size={13} />
                  {placeName ?? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`}
                </a>
              ) : (
                (placeName ?? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`)
              )}
              {accuracyMeters !== null ? (
                <span style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                  {t("attendance.locationAccuracy", { meters: Math.round(accuracyMeters) })}
                </span>
              ) : null}
            </span>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>{t("attendance.locationUnavailable")}</span>
          )}
        </div>
      </div>

      <Textarea label={t("attendance.noteLabel")} name="attendanceNote" value={note} onChange={(event) => setNote(event.target.value)} disabled={submitting} rows={2} placeholder={t("attendance.optionalPlaceholder")} />
      <div style={{ marginTop: "var(--space-3)" }}>
        <Textarea label={t("attendance.activityLabel")} name="attendanceActivity" value={activity} onChange={(event) => setActivity(event.target.value)} disabled={submitting} rows={2} placeholder={t("attendance.optionalPlaceholder")} />
      </div>

      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
