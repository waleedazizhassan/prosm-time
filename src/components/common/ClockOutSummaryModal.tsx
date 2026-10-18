import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Modal from "./Modal";
import Button from "./Button";

interface ClockOutSummaryModalProps {
  isOpen: boolean;
  workedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  exceptionsCount: number;
  onClose: () => void;
}

function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}h ${mins}m`;
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
  onClose,
}: ClockOutSummaryModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();

  const handleGoToAllowances = () => {
    onClose();
    navigate("/allowances");
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("attendance.summaryTitle")} size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginBottom: "var(--space-4)", fontSize: "var(--font-sm)" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryWorked")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(workedMinutes)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryBreak")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(breakMinutes)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-secondary)" }}>{t("attendance.summaryOvertime")}</span>
          <span style={{ fontWeight: "var(--font-weight-medium)", fontVariantNumeric: "tabular-nums" }}>{formatMinutes(overtimeMinutes)}</span>
        </div>
        {exceptionsCount > 0 ? (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--status-warning-text)" }}>{t("attendance.summaryExceptions")}</span>
            <span style={{ fontWeight: "var(--font-weight-medium)" }}>{exceptionsCount}</span>
          </div>
        ) : null}
      </div>


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
