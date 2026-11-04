import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import ShiftExtrasRepository, { type OpenShift } from "../../core/repositories/ShiftExtrasRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import FormGrid from "../../components/common/FormGrid";
import Input from "../../components/common/Input";

// docs/IDEAS.md 5: a manager posts a shift with no one on it; people at the site ask
// for it; the manager picks one. Everyone sees the card; only managers post and decide.
export default function OpenShiftsCard({ manageSiteId, onFilled }: { manageSiteId: string | null; onFilled: () => void }) {
  const { t, i18n } = useTranslation("schedule");
  const [shifts, setShifts] = useState<OpenShift[]>([]);
  const [date, setDate] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:00");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => void ShiftExtrasRepository.listOpenShifts().then(setShifts), []);
  useEffect(load, [load]);

  const post = async () => {
    if (!manageSiteId) return;
    setBusy(true);
    setError("");
    const failed = await ShiftExtrasRepository.createOpenShift(manageSiteId, date, `${start}:00`, `${end}:00`, notes);
    setBusy(false);
    if (failed) setError(humanizeBackendError(failed, t) ?? t("open.failed"));
    else {
      setNotes("");
      load();
    }
  };

  const decide = async (requestId: string, approve: boolean) => {
    setError("");
    const failed = await ShiftExtrasRepository.decideRequest(requestId, approve);
    if (failed) setError(humanizeBackendError(failed, t) ?? t("open.failed"));
    load();
    if (approve && !failed) onFilled();
  };

  if (shifts.length === 0 && !manageSiteId) return null;
  const time = (value: string) => value.slice(0, 5);

  return (
    <Card title={t("open.title")} subtitle={t("open.subtitle")}>
      <ErrorText>{error}</ErrorText>
      {shifts.length === 0 ? <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("open.none")}</p> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {shifts.map((shift) => (
          <div key={shift.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "var(--space-2)", alignItems: "center" }}>
              <span style={{ fontWeight: "var(--font-weight-semibold)" }}>
                {formatDateOnly(shift.shiftDate, i18n.language)} · {time(shift.startTime)} – {time(shift.endTime)} · {shift.siteName}
              </span>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t(`open.status.${shift.status}`)}</span>
            </div>
            {shift.notes ? <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-sm)" }}>{shift.notes}</p> : null}
            {shift.canManage ? (
              <div style={{ marginTop: "var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                {shift.requests.length === 0 ? <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("open.noRequests")}</span> : null}
                {shift.requests.map((request) => (
                  <div key={request.id} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "var(--font-sm)" }}>{request.name}</span>
                    {request.status === "pending" && shift.status === "open" ? (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
                        <Button size="sm" onClick={() => decide(request.id, true)}>
                          {t("open.give")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => decide(request.id, false)}>
                          {t("swap.reject")}
                        </Button>
                      </span>
                    ) : (
                      <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t(`swap.status.${request.status}`)}</span>
                    )}
                  </div>
                ))}
                {shift.status === "open" ? (
                  <Button size="sm" variant="ghost" onClick={() => ShiftExtrasRepository.cancelOpenShift(shift.id).then(load)}>
                    {t("open.cancel")}
                  </Button>
                ) : null}
              </div>
            ) : shift.myRequest ? (
              <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t(`open.mine.${shift.myRequest}`)}</p>
            ) : (
              <div style={{ marginTop: "var(--space-2)" }}>
                <Button size="sm" onClick={() => ShiftExtrasRepository.requestOpenShift(shift.id).then(load)}>
                  {t("open.ask")}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {manageSiteId ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <FormGrid columns={4} gap="sm">
            <Input label={t("columns.date")} name="openShiftDate" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <Input label={t("startTimeLabel")} name="openShiftStart" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
            <Input label={t("endTimeLabel")} name="openShiftEnd" type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
            <Input label={t("notesLabel")} name="openShiftNotes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </FormGrid>
          <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "var(--space-3)" }}>
            <Button onClick={post} loading={busy} disabled={busy || !date}>
              {t("open.post")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
