import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import SessionReviewRepository from "../../core/repositories/SessionReviewRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import styles from "./LongSessionPrompt.module.css";

// v2.3.43 step 2 (item 11): after the organisation's alert hours (12 by
// default) an open shift asks "still working?" - the same question the push
// notification asks. "Clock me out" opens the normal clock-out (location,
// photo), so nothing about a clock-out is skipped.
export default function LongSessionPrompt({ clockInAt, now, onClockOut }: { clockInAt: string; now: number; onClockOut: () => void }) {
  const { t } = useTranslation("dashboard");
  const [alertHours, setAlertHours] = useState(12);
  // owner 2026-11-13: "I press 'still working', leave the app and come back - and it asks again at once". The answer
  // is kept on the phone for this shift, so leaving and coming back does not ask again.
  const storageKey = `prosm_time_still_working:${clockInAt}`;
  const [answeredAt, setAnsweredAt] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem(storageKey)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setAlertHours(result.data.openSessionAlertHours);
    });
    // Opening the app during a shift is activity: an automatically closed
    // shift ends at the last one.
    void SessionReviewRepository.touchActivity();
  }, []);

  const hours = Math.floor((now - new Date(clockInAt).getTime()) / 3600000);
  // Asked again two hours after "still working" - never more often than every quarter of an hour.
  if (hours < alertHours || (answeredAt !== null && now - answeredAt < 2 * 3600000)) return null;

  const handleStillWorking = async () => {
    setSaving(true);
    setError("");
    const result = await SessionReviewRepository.stillWorking();
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("longSession.error"));
      return;
    }
    const at = Date.now();
    setAnsweredAt(at);
    try { localStorage.setItem(storageKey, String(at)); } catch { /* the answer still holds for this visit */ }
  };

  return (
    <div role="alert" className={styles.glass}>
      <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t("longSession.title")}</div>
      <p style={{ margin: "var(--space-1) 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("longSession.body", { hours })}</p>
      <div className={styles.actions}>
        <Button size="sm" onClick={handleStillWorking} loading={saving}>
          {t("longSession.stillWorking")}
        </Button>
        <Button size="sm" variant="danger" onClick={onClockOut} disabled={saving}>
          {t("longSession.clockOut")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
