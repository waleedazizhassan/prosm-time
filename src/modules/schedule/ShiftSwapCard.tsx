import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import ShiftRepository, { type MyShiftRow, type ShiftSwap, type SwapColleague } from "../../core/repositories/ShiftRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";

// Plan stage 8.3: hand a scheduled shift to a colleague at the same site, once a
// manager agrees. The server checks leave and overlaps when it is approved.
export default function ShiftSwapCard({ shifts, onChanged }: { shifts: MyShiftRow[]; onChanged: () => void }) {
  const { t, i18n } = useTranslation("schedule");
  const [swaps, setSwaps] = useState<ShiftSwap[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [colleagues, setColleagues] = useState<SwapColleague[]>([]);
  const [colleagueId, setColleagueId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => void ShiftRepository.listSwaps().then(setSwaps), []);
  useEffect(load, [load]);

  useEffect(() => {
    setColleagueId("");
    setColleagues([]);
    if (shiftId) void ShiftRepository.listSwapColleagues(shiftId).then(setColleagues);
  }, [shiftId]);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = shifts.filter((shift) => shift.status === "scheduled" && shift.shiftDate >= today);

  const request = async () => {
    setBusy(true);
    setError("");
    const ok = await ShiftRepository.requestSwap(shiftId, colleagueId, reason);
    setBusy(false);
    if (!ok) {
      setError(t("swap.failed"));
      return;
    }
    setShiftId("");
    setReason("");
    load();
  };

  const decide = async (id: string, approve: boolean) => {
    setError("");
    if (await ShiftRepository.decideSwap(id, approve)) {
      load();
      onChanged();
    } else setError(t("swap.failed"));
  };

  const columns: TableColumn<ShiftSwap>[] = [
    { key: "date", header: t("columns.date"), render: (row) => formatDateOnly(row.shiftDate, i18n.language) },
    { key: "time", header: t("columns.time"), render: (row) => `${row.startTime.slice(0, 5)} — ${row.endTime.slice(0, 5)}` },
    { key: "site", header: t("columns.site"), render: (row) => row.siteName },
    { key: "from", header: t("swap.from"), render: (row) => row.fromName ?? "—" },
    { key: "to", header: t("swap.to"), render: (row) => row.toName ?? "—" },
    { key: "reason", header: t("swap.reason"), render: (row) => row.reason ?? "—" },
    { key: "status", header: t("common:status"), render: (row) => t(`swap.status.${row.status}`) },
    {
      key: "actions",
      header: t("common:actions.label"),
      render: (row) =>
        row.canDecide ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
            <Button size="sm" onClick={() => decide(row.id, true)}>
              {t("swap.approve")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => decide(row.id, false)}>
              {t("swap.reject")}
            </Button>
          </div>
        ) : null,
    },
  ];

  if (upcoming.length === 0 && swaps.length === 0) return null;

  return (
    <Card title={t("swap.title")}>
      {upcoming.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end", marginBottom: "var(--space-3)" }}>
          <Select
            label={t("swap.shift")}
            name="swapShift"
            value={shiftId}
            onChange={(event) => setShiftId(event.target.value)}
            options={[{ value: "", label: t("swap.chooseShift") }, ...upcoming.map((shift) => ({ value: shift.id, label: `${formatDateOnly(shift.shiftDate, i18n.language)} · ${shift.siteName}` }))]}
          />
          <Select
            label={t("swap.to")}
            name="swapColleague"
            value={colleagueId}
            onChange={(event) => setColleagueId(event.target.value)}
            options={[{ value: "", label: t("swap.chooseColleague") }, ...colleagues.map((person) => ({ value: person.userId, label: person.fullName }))]}
          />
          <Input label={t("swap.reason")} name="swapReason" value={reason} onChange={(event) => setReason(event.target.value)} />
          <Button onClick={request} loading={busy} disabled={busy || !shiftId || !colleagueId}>
            {t("swap.request")}
          </Button>
        </div>
      ) : null}
      <ErrorText>{error}</ErrorText>
      {swaps.length > 0 ? <Table columns={columns} data={swaps} getRowId={(row) => row.id} emptyMessage="" /> : null}
    </Card>
  );
}
