import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import SessionReviewRepository, { type PendingSessionRow, type StaleOpenSessionRow } from "../../core/repositories/SessionReviewRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import ListRow from "../../components/common/ListRow";
import PersonName from "../../components/common/PersonName";

// "2026-10-25T14:30" in the reader's own time zone, for <input type="datetime-local">.
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// v2.3.43 step 2 (item 11): shifts closed automatically after the limit wait
// here; their hours count nowhere (timesheet, totals, allowances, overtime,
// cost) until the manager sets the real end, with a reason (audited). Shifts
// opened before the automatic close existed are listed below, not closed.
export default function PendingHoursCard() {
  const { t, i18n } = useTranslation("manager");
  const [pending, setPending] = useState<PendingSessionRow[]>([]);
  const [stale, setStale] = useState<StaleOpenSessionRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [target, setTarget] = useState<PendingSessionRow | null>(null);
  const [clockOut, setClockOut] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [pendingResult, staleResult] = await Promise.all([SessionReviewRepository.listPending(), SessionReviewRepository.listStaleOpen()]);
    if (!pendingResult.success) setLoadError(humanizeBackendError(pendingResult.message, t) ?? t("pendingHours.loadError"));
    setPending(pendingResult.data ?? []);
    setStale(staleResult.data ?? []);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (row: PendingSessionRow) => {
    setTarget(row);
    setClockOut(toLocalInputValue(row.clockOutAt));
    setReason("");
    setError("");
  };

  const handleSave = async () => {
    if (!target) return;
    if (!reason.trim()) {
      setError(t("pendingHours.reasonRequired"));
      return;
    }
    const end = new Date(clockOut);
    if (Number.isNaN(end.getTime())) {
      setError(t("pendingHours.invalidTime"));
      return;
    }
    setSaving(true);
    setError("");
    const result = await SessionReviewRepository.review(target.sessionId, end.toISOString(), reason.trim());
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("pendingHours.genericError"));
      return;
    }
    setTarget(null);
    await load();
  };

  if (pending.length === 0 && stale.length === 0 && !loadError) return null;

  const when = (iso: string) => `${formatDateOnly(iso, i18n.language)} ${formatTimeOnly(iso, i18n.language)}`;

  return (
    <Card title={t("pendingHours.title", { count: pending.length })}>
      <HintText small>{t("pendingHours.hint")}</HintText>
      <ErrorText>{loadError}</ErrorText>
      {pending.map((row) => (
        <ListRow key={row.sessionId}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
              <PersonName name={row.employeeName} url={row.avatarUrl}>{row.employeeName}{row.siteName ? ` — ${row.siteName}` : ""}</PersonName>
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t("pendingHours.summary", { clockIn: when(row.clockInAt), clockOut: when(row.clockOutAt) })}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => open(row)}>
            {t("pendingHours.reviewAction")}
          </Button>
        </ListRow>
      ))}

      {stale.length > 0 ? (
        <>
          <h3 style={{ margin: "var(--space-4) 0 var(--space-2)", fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("pendingHours.staleTitle")}</h3>
          <HintText small>{t("pendingHours.staleHint")}</HintText>
          {stale.map((row) => (
            <ListRow key={row.sessionId}>
              <div>
                <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>
                  {row.employeeName}
                  {row.siteName ? ` — ${row.siteName}` : ""}
                </div>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                  {t("pendingHours.staleSummary", { clockIn: when(row.clockInAt), hours: row.openHours })}
                </div>
              </div>
            </ListRow>
          ))}
        </>
      ) : null}

      <Modal
        isOpen={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `${target.employeeName} — ${t("pendingHours.modalTitle")}` : ""}
        footer={
          <Button onClick={handleSave} loading={saving}>
            {t("pendingHours.save")}
          </Button>
        }
      >
        {target ? (
          <>
            <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {t("pendingHours.modalBody", { clockIn: when(target.clockInAt), lastActivity: target.lastActivityAt ? when(target.lastActivityAt) : "—" })}
            </p>
            <Input label={t("pendingHours.clockOutLabel")} name="pendingClockOut" type="datetime-local" value={clockOut} onChange={(event) => setClockOut(event.target.value)} disabled={saving} />
            <Textarea label={t("pendingHours.reasonLabel")} name="pendingReason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving} />
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
