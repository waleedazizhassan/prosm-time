import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";

import Modal from "./Modal";
import Button from "./Button";
import Textarea from "./Textarea";
import ErrorText from "./ErrorText";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";

interface AttendanceConfirmModalProps {
  isOpen: boolean;
  action: "clockIn" | "clockOut";
  photoPreviewUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  placeName: string | null;
  siteName: string;
  // Owner 2026-11-02: how far outside the chosen site's area the person stands, said before they confirm.
  outsideByMeters?: number | null;
  submitting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (note: string, activity: string) => void;
  /** 2026-11-09 (owner): who, from which device, and the last clock-out - at the top of the screen */
  personName?: string | null;
  deviceLabel?: string | null;
  lastClockOutLabel?: string | null;
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
  outsideByMeters = null,
  submitting,
  error,
  onCancel,
  onConfirm,
  personName = null,
  deviceLabel = null,
  lastClockOutLabel = null,
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
      size="screen"
      footer={
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%" }}>
          <Button variant={action === "clockIn" ? "primary" : "danger"} fullWidth onClick={() => onConfirm(note, activity)} loading={submitting}>
            {t(action === "clockIn" ? "attendance.confirmClockInAction" : "attendance.confirmClockOutAction")}
          </Button>
          <Button variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      }
    >
      {/* § live UX review, user-directed - "the capture happens twice":
          landing on a second, full-size photo re-display right after
          Camera's own Use Photo/Retake step read as a second capture
          screen. A small confirmation chip (not a hero image) keeps the
          reassurance that a photo was attached without repeating the
          review step - this is the note-adding screen, not another
          photo screen. */}
      {/* 2026-11-09 (owner): step 3 - who and when at a glance, the photo large and round */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
        {photoPreviewUrl ? (
          <img src={photoPreviewUrl} alt={t("attendance.confirmPhotoLabel")}
            style={{ width: 104, height: 104, objectFit: "cover", borderRadius: "50%", flexShrink: 0, border: "3px solid transparent", background: "var(--brand-gradient) border-box", padding: 2 }} />
        ) : null}
        <div style={{ minWidth: 0 }}>
          {personName ? <div style={{ fontSize: "var(--font-xl)", fontWeight: "var(--font-weight-bold)", color: "var(--text-primary)" }}>{personName}</div> : null}
          {deviceLabel ? <div style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("attendance.viaDevice", { device: deviceLabel })}</div> : null}
          {lastClockOutLabel ? <div style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{lastClockOutLabel}</div> : null}
          {!photoPreviewUrl ? <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("attendance.confirmNoPhoto")}</div> : null}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <div style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-hover)", textAlign: "center" }}>
          <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("attendance.confirmDateLabel")}</div>
          <div style={{ fontWeight: "var(--font-weight-bold)" }}>{formatDateOnly(new Date(), i18n.language)}</div>
        </div>
        <div style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-hover)", textAlign: "center" }}>
          <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("attendance.confirmTimeLabel")}</div>
          <div style={{ fontWeight: "var(--font-weight-bold)", fontSize: "var(--font-lg)" }}>{formatTimeOnly(new Date().toISOString(), i18n.language)}</div>
        </div>
      </div>

      {outsideByMeters ? (
        <p role="alert" style={{ margin: "0 0 var(--space-3)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--status-warning-bg)", color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>
          {t("attendance.confirmOutside", { site: siteName, meters: outsideByMeters })}
        </p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginBottom: "var(--space-4)", fontSize: "var(--font-sm)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-3)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.siteLabel")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", textAlign: "end" }}>{siteName}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", alignItems: "flex-start", gap: "var(--space-3)" }}>
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
