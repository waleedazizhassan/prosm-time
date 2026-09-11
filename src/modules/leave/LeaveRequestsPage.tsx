import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import LeaveRepository, { type LeaveRequestRow, type LeaveBalanceEntry, type LeaveType } from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import PageBanner from "../../components/common/PageBanner";
import leaveIllustration from "../../assets/illustration-leave-scene.png";

const LEAVE_TYPES: LeaveType[] = ["annual", "sick", "unpaid", "emergency", "other"];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const STATUS_BADGE_KEY: Record<LeaveRequestRow["status"], string> = {
  pending: "pending",
  approved: "approved",
  rejected: "revoked",
  cancelled: "cancelled",
};

// PROSM Time - § user-directed: real PTO/leave management. Every
// competitor researched this session (Jibble, Deputy, Connecteam,
// ClockShark, Homebase) has request/approve leave with balance
// tracking; PROSM Time had none until now. Balance is real only for
// 'annual' leave (see get_prosm_time_leave_balance's own header
// comment) - every other type here only ever shows days taken this
// year, deliberately never a hard cap.
export default function LeaveRequestsPage() {
  const { t, i18n } = useTranslation("leave");

  const today = new Date();
  const [requests, setRequests] = useState<LeaveRequestRow[]>([]);
  const [balances, setBalances] = useState<LeaveBalanceEntry[]>([]);
  const [balanceYear, setBalanceYear] = useState<number>(today.getFullYear());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState(isoDate(today));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [requestsResult, balanceResult] = await Promise.all([LeaveRepository.listMine(), LeaveRepository.getBalance()]);
    if (!requestsResult.success) {
      setLoadError(humanizeBackendError(requestsResult.message, t) ?? t("loadError"));
    } else {
      setRequests(requestsResult.data ?? []);
    }
    if (balanceResult.success && balanceResult.data) {
      setBalances(balanceResult.data.balances);
      setBalanceYear(balanceResult.data.year);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async () => {
    if (!startDate || !endDate) return;
    setSubmitting(true);
    setSubmitError("");
    const result = await LeaveRepository.request(leaveType, startDate, endDate, reason);
    setSubmitting(false);
    if (!result.success) {
      setSubmitError(humanizeBackendError(result.message, t) ?? t("submitError"));
      return;
    }
    setReason("");
    await load();
  };

  const handleCancel = async (requestId: string) => {
    setCancellingId(requestId);
    setLoadError("");
    const result = await LeaveRepository.cancel(requestId);
    setCancellingId(null);
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("cancelError"));
      return;
    }
    await load();
  };

  const columns: TableColumn<LeaveRequestRow>[] = [
    { key: "type", header: t("columns.type"), render: (row) => t(`types.${row.leaveType}`) },
    { key: "dates", header: t("columns.dates"), render: (row) => `${formatDateOnly(row.startDate, i18n.language)} — ${formatDateOnly(row.endDate, i18n.language)}` },
    { key: "days", header: t("columns.days"), render: (row) => row.daysCount },
    { key: "reason", header: t("columns.reason"), render: (row) => row.reason ?? "—" },
    { key: "status", header: t("columns.status"), render: (row) => <StatusBadge status={STATUS_BADGE_KEY[row.status]}>{t(`status.${row.status}`)}</StatusBadge> },
    {
      key: "actions",
      header: t("common:actions.label"),
      render: (row) =>
        row.status === "pending" ? (
          <Button variant="ghost" size="sm" onClick={() => handleCancel(row.id)} loading={cancellingId === row.id}>
            {t("cancelAction")}
          </Button>
        ) : null,
    },
  ];

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <PageBanner src={leaveIllustration} />
      <Card title={t("balanceTitle", { year: balanceYear })}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          {balances.map((entry) => (
            <div
              key={entry.leaveType}
              style={{
                minWidth: 140,
                padding: "var(--space-3)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-hover)",
                flex: "1 1 140px",
              }}
            >
              <p style={{ margin: 0, fontSize: "var(--font-xs)", fontWeight: "var(--font-weight-bold)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)" }}>
                {t(`types.${entry.leaveType}`)}
              </p>
              {entry.remainingDays !== null ? (
                <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-xl)", fontWeight: "var(--font-weight-bold)", fontVariantNumeric: "tabular-nums" }}>
                  {entry.remainingDays} <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)", fontWeight: "var(--font-weight-normal)" }}>{t("daysRemainingSuffix")}</span>
                </p>
              ) : (
                <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-lg)", fontWeight: "var(--font-weight-bold)", fontVariantNumeric: "tabular-nums" }}>
                  {entry.usedDays} <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)", fontWeight: "var(--font-weight-normal)" }}>{t("daysTakenSuffix")}</span>
                </p>
              )}
              {entry.entitledDays !== null ? (
                <p style={{ margin: "2px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("balanceDetail", { used: entry.usedDays, pending: entry.pendingDays, entitled: entry.entitledDays })}</p>
              ) : entry.pendingDays > 0 ? (
                <p style={{ margin: "2px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("pendingSuffix", { pending: entry.pendingDays })}</p>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card title={t("requestFormTitle")}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
          <Select
            label={t("columns.type")}
            name="leaveType"
            value={leaveType}
            onChange={(event) => setLeaveType(event.target.value as LeaveType)}
            disabled={submitting}
            options={LEAVE_TYPES.map((type) => ({ value: type, label: t(`types.${type}`) }))}
          />
          <Input label={t("startDateLabel")} name="leaveStartDate" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} disabled={submitting} />
          <Input label={t("endDateLabel")} name="leaveEndDate" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={submitting} />
        </div>
        <Textarea label={t("reasonLabel")} name="leaveReason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={submitting} rows={2} />
        <ErrorText>{submitError}</ErrorText>
        <Button onClick={handleSubmit} loading={submitting} disabled={!startDate || !endDate}>
          {t("submitAction")}
        </Button>
      </Card>

      <Card title={t("myRequestsTitle")}>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={columns} data={requests} getRowId={(row) => row.id} loading={loading} emptyMessage={t("empty")} />
      </Card>
    </PageShell>
  );
}
