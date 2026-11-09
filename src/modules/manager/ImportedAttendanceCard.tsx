import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

interface ImportedEvent {
  id: string;
  externalId: string;
  employeeId: string;
  employeeName: string;
  siteName: string | null;
  type: "clock_in" | "clock_out";
  occurredAt: string;
  device: string | null;
  reason: string | null;
  source: string | null;
}

// 2026-11-09 (integration API v1a, spec 17.3 item 6): attendance another system sent through the
// API waits here. It counts for nothing until approved: approving turns each clock-in and the next
// clock-out of the same person into one attendance record (audited); an overlap or a missing
// clock-out stays here with the reason. Rejecting needs a reason. The server checks who may.
export default function ImportedAttendanceCard() {
  const { t, i18n } = useTranslation("manager");
  const [events, setEvents] = useState<ImportedEvent[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const client = DatabaseManager.getClient();

  const load = useCallback(async () => {
    const { data, error: loadError } = await client.rpc("list_prosm_time_imported_attendance", { p_status: "pending" });
    if (loadError) setError(humanizeBackendError(loadError.message, t) ?? t("imported.error"));
    setEvents((data ?? []) as ImportedEvent[]);
  }, [client, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (events.length === 0 && !error) return null;

  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const approve = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const { data, error: rpcError } = await client.rpc("approve_prosm_time_imported_attendance", { p_ids: chosen });
    setBusy(false);
    if (rpcError) {
      setError(humanizeBackendError(rpcError.message, t) ?? t("imported.error"));
      return;
    }
    setNotice(t("imported.approved", { applied: data?.applied ?? 0, pending: data?.stillPending ?? 0 }));
    setChosen([]);
    await load();
  };
  const reject = async () => {
    setBusy(true);
    setError("");
    const { error: rpcError } = await client.rpc("reject_prosm_time_imported_attendance", { p_ids: chosen, p_reason: reason.trim() });
    setBusy(false);
    if (rpcError) {
      setError(humanizeBackendError(rpcError.message, t) ?? t("imported.error"));
      return;
    }
    setRejecting(false);
    setReason("");
    setChosen([]);
    await load();
  };

  return (
    <Card title={t("imported.title", { count: events.length })}>
      <HintText>{t("imported.hint")}</HintText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <Button size="sm" variant="ghost" onClick={() => setChosen(chosen.length === events.length ? [] : events.map((e) => e.id))}>
          {chosen.length === events.length ? t("imported.chooseNone") : t("imported.chooseAll")}
        </Button>
        <Button size="sm" disabled={chosen.length === 0} loading={busy} onClick={approve}>{t("imported.approve", { count: chosen.length })}</Button>
        <Button size="sm" variant="ghost" disabled={chosen.length === 0} onClick={() => setRejecting(true)}>{t("imported.reject")}</Button>
      </div>
      {notice ? <HintText small>{notice}</HintText> : null}
      <ErrorText>{error}</ErrorText>
      {events.map((event) => (
        <label key={event.id} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border-light)", fontSize: "var(--font-sm)" }}>
          <input type="checkbox" checked={chosen.includes(event.id)} onChange={() => toggle(event.id)} />
          <span style={{ flex: 1 }}>
            <strong>{event.employeeName}</strong> · {t(`imported.type.${event.type}`)} · {formatDateOnly(event.occurredAt, i18n.language)} {formatTimeOnly(event.occurredAt, i18n.language)}
            {event.siteName ? ` · ${event.siteName}` : ""}
            <span style={{ color: "var(--text-secondary)" }}>
              {event.source || event.device ? ` · ${[event.source, event.device].filter(Boolean).join(" / ")}` : ""}
              {event.reason ? ` · ${t(`imported.reasons.${event.reason}`, { defaultValue: event.reason })}` : ""}
            </span>
          </span>
        </label>
      ))}
      <Modal isOpen={rejecting} onClose={() => setRejecting(false)} title={t("imported.rejectTitle", { count: chosen.length })}
        footer={<Button loading={busy} disabled={reason.trim().length < 3} onClick={reject}>{t("imported.reject")}</Button>}>
        <Textarea label={t("imported.reason")} name="importRejectReason" value={reason} onChange={(event) => setReason(event.target.value)} />
      </Modal>
    </Card>
  );
}
