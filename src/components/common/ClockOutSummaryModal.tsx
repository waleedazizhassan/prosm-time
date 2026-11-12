import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Modal from "./Modal";
import Button from "./Button";
import MoodFace, { type ShiftMood } from "./MoodFace";
import { requireSupabaseClient } from "../../core/api/supabaseClient";

interface ClockOutSummaryModalProps {
  isOpen: boolean;
  workedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  exceptionsCount: number;
  /** Owner 2026-11-11: the shift just closed - "how was today's work?" is answered for it. */
  sessionId?: string | null;
  onClose: () => void;
}

const MOODS: ShiftMood[] = ["great", "normal", "tough"];

function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}:${String(mins).padStart(2, "0")}`;
}

// PROSM Time - § live UX review, user-directed: a real summary shown
// right after a successful Clock Out (worked/break/overtime minutes,
// exceptions logged this shift). Owner 2026-10-18: no early-leave reason
// prompt any more - the note the employee writes when clocking out is
// shown in the Notes column of the attendance record instead.
// "Complete Allowances Now" is offered unconditionally, not only on
// early leave - the same posture as the rest of this shift's own
// optional follow-ups (never a hard requirement to leave this screen).
export default function ClockOutSummaryModal({
  isOpen,
  workedMinutes,
  breakMinutes,
  overtimeMinutes,
  exceptionsCount,
  sessionId = null,
  onClose,
}: ClockOutSummaryModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const [mood, setMood] = useState<ShiftMood | null>(null);
  const [moodSaved, setMoodSaved] = useState(false);

  // one tap answers; another face can still be chosen instead
  const chooseMood = async (next: ShiftMood) => {
    setMood(next);
    setMoodSaved(false);
    if (!sessionId || sessionId.startsWith("q:")) return;
    const { error } = await requireSupabaseClient().rpc("set_prosm_time_shift_mood", { p_session_id: sessionId, p_mood: next });
    if (!error) setMoodSaved(true);
  };

  const handleGoToAllowances = () => {
    onClose();
    navigate("/allowances");
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("attendance.summaryTitle")} size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginBottom: "var(--space-4)", fontSize: "var(--font-sm)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryWorked")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(workedMinutes)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryBreak")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(breakMinutes)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryOvertime")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(overtimeMinutes)}</span>
        </div>
        {exceptionsCount > 0 ? (
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ color: "var(--status-warning-text)" }}>{t("attendance.summaryExceptions")}</span>
            <span style={{ fontWeight: "var(--font-weight-medium)" }}>{exceptionsCount}</span>
          </div>
        ) : null}
      </div>

      {sessionId ? (
        <div style={{ margin: "0 0 var(--space-4)", textAlign: "center" }}>
          <p style={{ margin: "0 0 var(--space-3)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t("attendance.mood.question")}</p>
          <div role="radiogroup" aria-label={t("attendance.mood.question")} style={{ display: "flex", justifyContent: "center", gap: "var(--space-4)" }}>
            {MOODS.map((key) => (
              <button key={key} type="button" role="radio" aria-checked={mood === key} onClick={() => void chooseMood(key)}
                style={{ display: "grid", justifyItems: "center", gap: 6, padding: 4, border: 0, background: "none", cursor: "pointer",
                  color: mood && mood !== key ? "var(--border-strong)" : "var(--text-secondary)", font: "inherit", fontSize: "var(--font-sm)" }}>
                <MoodFace mood={key} active={mood === key} />
                <span>{t(`attendance.mood.${key}`)}</span>
              </button>
            ))}
          </div>
          {moodSaved ? <p role="status" style={{ margin: "var(--space-2) 0 0", color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("attendance.mood.thanks")}</p> : null}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <Button fullWidth onClick={handleGoToAllowances}>
          {t("attendance.summaryAllowancesAction")}
        </Button>
        <Button variant="ghost" fullWidth onClick={onClose}>
          {t("attendance.summaryNotNowAction")}
        </Button>
      </div>
    </Modal>
  );
}
