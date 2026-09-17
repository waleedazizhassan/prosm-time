import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";
import { MapPin } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import ManagerRepository, { type SosAlertRow } from "../../core/repositories/ManagerRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateTime } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import emergencyHeaderImage from "../../assets/illustration-emergency-header.png";

const ALL_EMPLOYEES = "";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// PROSM Time - user-directed: an SOS/emergency alert must be more than
// a notification - clicking it (or the full-screen siren overlay's
// "View" action, SosAlertOverlay.tsx) has to land on a real record
// showing the emergency's exact GPS location, its timestamp, the
// employee, the work site, and everything about both. Same "own
// picked date range" list shape as AttendanceLogPage, over sos_alerts'
// own RLS (visible to the alerting employee, attendance.view holders,
// or the Owner) - a plain employee opening this by mistake would only
// ever see their own alerts, same graceful-degradation posture as
// every other RLS-scoped screen in this app. Gated on the nav item
// itself, though, matching Manager Console: this is an admin/manager
// tool, not something a plain employee is meant to browse to.
export default function EmergencyLogPage() {
  const { t, i18n } = useTranslation("emergencyLog");
  const { profile, hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canView = profile?.isOwner || hasPermission("attendance.view");
  const canResolve = profile?.isOwner || hasPermission("attendance.clock_out_on_behalf");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [startDate, setStartDate] = useState(isoDate(monthStart));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [rows, setRows] = useState<SosAlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState(ALL_EMPLOYEES);

  const [selectedAlert, setSelectedAlert] = useState<SosAlertRow | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const load = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setLoadError("");
    const result = await ManagerRepository.listSosAlerts(startDate, endDate);
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(result.data ?? []);
    setLoading(false);
  }, [startDate, endDate, t]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  // The notification bell (both the panel item and the siren overlay's
  // "View" action) links here with ?alertId=<sos_alerts.id> - once this
  // period's rows are loaded, open that specific alert's detail
  // automatically so "clicking the notification" really does land on
  // its record, not just this list.
  useEffect(() => {
    const alertId = searchParams.get("alertId");
    if (!alertId || loading) return;
    const match = rows.find((row) => row.id === alertId);
    if (match) {
      setSelectedAlert(match);
      setResolutionNotes("");
      setResolveError("");
      const next = new URLSearchParams(searchParams);
      next.delete("alertId");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, rows, loading, setSearchParams]);

  const employeeNames = useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(rows.map((row) => row.userFullName))).sort(collator.compare);
  }, [rows, i18n.language]);
  const showEmployeeFilter = employeeNames.length > 1;
  const employeeOptions = useMemo(
    () => [{ value: ALL_EMPLOYEES, label: t("filters.allEmployees") }, ...employeeNames.map((name) => ({ value: name, label: name }))],
    [employeeNames, t],
  );

  useEffect(() => {
    if (employeeFilter !== ALL_EMPLOYEES && !rows.some((row) => row.userFullName === employeeFilter)) {
      setEmployeeFilter(ALL_EMPLOYEES);
    }
  }, [rows, employeeFilter]);

  const filteredRows = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? rows : rows.filter((row) => row.userFullName === employeeFilter)),
    [rows, employeeFilter],
  );

  if (!canView) return <Navigate to="/dashboard" replace />;

  const openDetail = (row: SosAlertRow) => {
    setSelectedAlert(row);
    setResolutionNotes("");
    setResolveError("");
  };

  const closeDetail = () => {
    setSelectedAlert(null);
    setResolutionNotes("");
    setResolveError("");
  };

  const handleResolve = async () => {
    if (!selectedAlert) return;
    setResolving(true);
    setResolveError("");
    const result = await ManagerRepository.resolveSosAlert(selectedAlert.id, resolutionNotes);
    setResolving(false);
    if (!result.success) {
      setResolveError(humanizeBackendError(result.message, t) ?? t("detail.resolveError"));
      return;
    }
    closeDetail();
    load();
  };

  const columns: TableColumn<SosAlertRow>[] = [
    { key: "employee", header: t("columns.employee"), render: (row) => row.userFullName },
    { key: "site", header: t("columns.site"), render: (row) => row.siteName || "—" },
    { key: "triggeredAt", header: t("columns.triggeredAt"), render: (row) => formatDateTime(row.triggeredAt, i18n.language) },
    {
      key: "location",
      header: t("columns.location"),
      render: (row) =>
        row.latitude !== null && row.longitude !== null ? (
          <a
            href={`https://www.google.com/maps?q=${row.latitude},${row.longitude}`}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: "2px", color: "var(--text-link)", textDecoration: "none", fontSize: "var(--font-xs)" }}
          >
            <MapPin size={13} />
            {row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
          </a>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      header: t("columns.status"),
      render: (row) => <StatusBadge status={row.status === "active" ? "sosActive" : "sosResolved"}>{t(`status.${row.status}`)}</StatusBadge>,
    },
  ];

  return (
    <PageShell title="">
      <img
        src={emergencyHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "4.9cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

      <Card title={t("filters.title")}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Input label={t("filters.fromLabel")} name="emergencyLogFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <Input label={t("filters.toLabel")} name="emergencyLogTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          {showEmployeeFilter ? (
            <Select label={t("filters.employeeLabel")} name="emergencyLogEmployee" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} options={employeeOptions} />
          ) : null}
        </div>
      </Card>

      <Card>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={columns} data={filteredRows} getRowId={(row) => row.id} loading={loading} emptyMessage={t("empty")} onRowClick={openDetail} />
      </Card>

      <Modal isOpen={Boolean(selectedAlert)} onClose={closeDetail} title={t("detail.title")}>
        {selectedAlert ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <StatusBadge status={selectedAlert.status === "active" ? "sosActive" : "sosResolved"}>{t(`status.${selectedAlert.status}`)}</StatusBadge>

            <div>
              <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.employeeLabel")}</p>
              <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{selectedAlert.userFullName}</p>
              {selectedAlert.userEmail ? <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{selectedAlert.userEmail}</p> : null}
            </div>

            <div>
              <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.siteLabel")}</p>
              <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{selectedAlert.siteName || "—"}</p>
              {selectedAlert.siteDisplayAddress ? <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{selectedAlert.siteDisplayAddress}</p> : null}
            </div>

            <div>
              <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.triggeredAtLabel")}</p>
              <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{formatDateTime(selectedAlert.triggeredAt, i18n.language)}</p>
            </div>

            <div>
              <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.locationLabel")}</p>
              {selectedAlert.latitude !== null && selectedAlert.longitude !== null ? (
                <a
                  href={`https://www.google.com/maps?q=${selectedAlert.latitude},${selectedAlert.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)", color: "var(--text-link)", fontSize: "var(--font-sm)" }}
                >
                  <MapPin size={14} />
                  {selectedAlert.latitude.toFixed(6)}, {selectedAlert.longitude.toFixed(6)}
                </a>
              ) : (
                <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>—</p>
              )}
              {selectedAlert.accuracyMeters !== null ? (
                <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.accuracyLabel", { meters: Math.round(selectedAlert.accuracyMeters) })}</p>
              ) : null}
            </div>

            {selectedAlert.status === "resolved" ? (
              <div>
                <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("detail.resolvedAtLabel")}</p>
                <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{selectedAlert.resolvedAt ? formatDateTime(selectedAlert.resolvedAt, i18n.language) : "—"}</p>
                {selectedAlert.resolutionNotes ? <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{selectedAlert.resolutionNotes}</p> : null}
              </div>
            ) : canResolve ? (
              <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: "var(--space-3)" }}>
                <Textarea label={t("detail.resolutionNotesLabel")} name="sosResolutionNotes" value={resolutionNotes} onChange={(event) => setResolutionNotes(event.target.value)} disabled={resolving} />
                <ErrorText>{resolveError}</ErrorText>
                <Button onClick={handleResolve} loading={resolving}>
                  {t("detail.resolveAction")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </PageShell>
  );
}
