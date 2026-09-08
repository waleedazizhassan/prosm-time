import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Modal from "./Modal";
import Button from "./Button";
import Textarea from "./Textarea";
import ErrorText from "./ErrorText";

interface ClockOutSummaryModalProps {
  isOpen: boolean;
  workedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  exceptionsCount: number;
  leftEarly: boolean;
  earlyMinutes: number;
  earlyLeaveReason: string | null;
  reasonSubmitting: boolean;
  reasonSaved: boolean;
  error: string;
  onSubmitReason: (reason: string) => void;
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
// exceptions logged this shift), with a reason field when the employee
// left before the site's own shift_end_time (early leave has no
// "consequence" beyond notifying supervisors - matching how an out-of-
// zone reason already works, submit_prosm_time_early_leave_reason).
// "Complete Allowances Now" is offered unconditionally, not only on
// early leave - the same posture as the rest of this shift's own
// optional follow-ups (never a hard requirement to leave this screen).
export default function ClockOutSummaryModal({
  isOpen,
  workedMinutes,
  breakMinutes,
  overtimeMinutes,
  exceptionsCount,
  leftEarly,
  earlyMinutes,
  earlyLeaveReason,
  reasonSubmitting,
  reasonSaved,
  error,
  onSubmitReason,
  onClose,
}: ClockOutSummaryModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const [reason, setReason] = useState("");

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

      {leftEarly ? (
        <div style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-hover)", marginBottom: "var(--space-4)" }}>
          <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--status-warning-text)" }}>
            {t("attendance.summaryLeftEarlyWarning", { minutes: Math.round(earlyMinutes) })}
          </p>
          {earlyLeaveReason || reasonSaved ? (
            <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("attendance.summaryEarlyReasonSaved")}</p>
          ) : (
            <>
              <Textarea
                label={t("attendance.summaryEarlyReasonLabel")}
                name="earlyLeaveReason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={reasonSubmitting}
                rows={2}
              />
              <Button size="sm" onClick={() => onSubmitReason(reason)} loading={reasonSubmitting} disabled={!reason.trim()} style={{ marginTop: "var(--space-2)" }}>
                {t("attendance.summaryEarlyReasonSubmit")}
              </Button>
              <ErrorText>{error}</ErrorText>
            </>
          )}
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
