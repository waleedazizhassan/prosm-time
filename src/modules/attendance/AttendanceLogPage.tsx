import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera } from "lucide-react";

import ManagerRepository, { type TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Modal from "../../components/common/Modal";
import { formatTimeOnly } from "../../core/utils/formatDate";

function formatWorkedHours(clockInAt: string, clockOutAt: string | null): string {
  const endMs = clockOutAt ? new Date(clockOutAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((endMs - new Date(clockInAt).getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// PROSM Time - direct sidebar request (live UX review, user-directed):
// "a direct sidebar button to view employees' clock-in/clock-out
// record." Deliberately its own screen rather than folded into
// Manager Console (which stays "today + pending reviews only", its
// own documented scope) or Timesheets (which is period-object
// generation/approval, not a raw log). No permission gate at all -
// attendance_sessions' own RLS already returns exactly what the
// caller is entitled to see (their own sessions always; a Manager's
// own managed sites' people; everyone, for the Owner - 20260902090000)
// so an employee opening this same screen simply sees their own
// history, with zero role branching needed in this component.
export default function AttendanceLogPage() {
  const { t, i18n } = useTranslation("attendanceLog");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [startDate, setStartDate] = useState(isoDate(monthStart));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [rows, setRows] = useState<TodayAttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [evidenceModalTitle, setEvidenceModalTitle] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");

  const load = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setLoadError("");
    const result = await ManagerRepository.listAttendanceHistory(startDate, endDate);
    if (!result.success) {
      setLoadError(result.message ?? t("loadError"));
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(result.data ?? []);
    setLoading(false);
  }, [startDate, endDate, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openEvidence = async (storagePath: string, title: string) => {
    setEvidenceModalTitle(title);
    setEvidenceUrl(null);
    setEvidenceError("");
    setEvidenceLoading(true);
    const result = await EvidenceRepository.getEvidenceObjectUrl(storagePath);
    setEvidenceLoading(false);
    if (!result.success || !result.data) {
      setEvidenceError(result.message ?? t("photoLoadError"));
      return;
    }
    setEvidenceUrl(result.data);
  };

  const closeEvidence = () => {
    if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
    setEvidenceModalTitle(null);
    setEvidenceUrl(null);
    setEvidenceError("");
  };

  const columns: TableColumn<TodayAttendanceRow>[] = [
    { key: "name", header: t("columns.employee"), render: (row) => row.userFullName },
    { key: "site", header: t("columns.site"), render: (row) => row.siteName || "—" },
    {
      key: "clockInAt",
      header: t("columns.clockInAt"),
      render: (row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
          {formatTimeOnly(row.clockInAt, i18n.language)}
          {row.clockInEvidencePath ? (
            <button
              type="button"
              onClick={() => openEvidence(row.clockInEvidencePath as string, `${row.userFullName} — ${t("columns.clockInAt")}`)}
              title={t("viewPhoto")}
              aria-label={t("viewPhoto")}
              style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
            >
              <Camera size={14} />
            </button>
          ) : null}
        </span>
      ),
    },
    {
      key: "clockOutAt",
      header: t("columns.clockOutAt"),
      render: (row) =>
        row.clockOutAt ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
            {formatTimeOnly(row.clockOutAt, i18n.language)}
            {row.clockOutEvidencePath ? (
              <button
                type="button"
                onClick={() => openEvidence(row.clockOutEvidencePath as string, `${row.userFullName} — ${t("columns.clockOutAt")}`)}
                title={t("viewPhoto")}
                aria-label={t("viewPhoto")}
                style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
              >
                <Camera size={14} />
              </button>
            ) : null}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "status", header: t("columns.status"), render: (row) => <StatusBadge status={row.status === "clocked_in" ? "active" : "neutral"}>{t(`status.${row.status}`)}</StatusBadge> },
    { key: "workedHours", header: t("columns.workedHours"), render: (row) => formatWorkedHours(row.clockInAt, row.clockOutAt) },
  ];

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <Card title={t("filters.title")}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Input label={t("filters.fromLabel")} name="attendanceLogFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <Input label={t("filters.toLabel")} name="attendanceLogTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </div>
      </Card>

      <Card>
        {loadError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{loadError}</p> : null}
        <Table columns={columns} data={rows} getRowId={(row) => row.sessionId} loading={loading} emptyMessage={t("empty")} />
      </Card>

      <Modal isOpen={Boolean(evidenceModalTitle)} onClose={closeEvidence} title={evidenceModalTitle ?? t("photoModalTitle")}>
        {evidenceLoading ? (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("photoLoading")}</p>
        ) : evidenceError ? (
          <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{evidenceError}</p>
        ) : evidenceUrl ? (
          <img src={evidenceUrl} alt={t("photoAlt")} style={{ maxWidth: "100%", borderRadius: "var(--radius-md)", display: "block" }} />
        ) : null}
      </Modal>
    </PageShell>
  );
}
