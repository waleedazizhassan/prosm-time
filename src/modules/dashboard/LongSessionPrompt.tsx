import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import SessionReviewRepository from "../../core/repositories/SessionReviewRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

// v2.3.43 step 2 (item 11): after the organisation's alert hours (12 by
// default) an open shift asks "still working?" - the same question the push
// notification asks. "Clock me out" opens the normal clock-out (location,
// photo), so nothing about a clock-out is skipped.
export default function LongSessionPrompt({ clockInAt, now, onClockOut }: { clockInAt: string; now: number; onClockOut: () => void }) {
  const { t } = useTranslation("dashboard");
  const [alertHours, setAlertHours] = useState(12);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
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
  // Asked again two hours after "still working".
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
    setAnsweredAt(Date.now());
  };

  return (
    <div
      role="alert"
      style={{
        margin: "var(--space-3) 0",
        padding: "var(--space-3)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--status-warning, var(--border-strong))",
        background: "var(--surface-app)",
      }}
    >
      <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t("longSession.title")}</div>
      <p style={{ margin: "var(--space-1) 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("longSession.body", { hours })}</p>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
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
