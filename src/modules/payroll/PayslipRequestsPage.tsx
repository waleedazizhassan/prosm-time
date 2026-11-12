import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import PayrollCycleRepository, { type PayslipRequest } from "../../core/repositories/PayrollCycleRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import { payrollError } from "./payrollUi";
import SuccessText from "../../components/common/SuccessText";
import PayslipRequestModal from "./PayslipRequestModal";

const BADGE: Record<PayslipRequest["status"], string> = { pending: "pending", sent: "active", failed: "inactive", rejected: "revoked" };

// Owner 2026-11-08: the payslip requests a manager may handle (their payroll scope only). One click
// sends the approved, stored payslip of the published version as a PDF to the employee's
// registered email; a failure stays open with its error and can be retried.
export default function PayslipRequestsPage() {
  const { t, i18n } = useTranslation("payroll");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [requests, setRequests] = useState<PayslipRequest[] | null>(null);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<PayslipRequest | null>(null);
  const wanted = searchParams.get("open");

  const load = useCallback(async () => {
    const result = await PayrollCycleRepository.listRequests(null);
    if (result.error) setError(payrollError(result.error, t));
    setRequests(result.data ?? []);
    return result.data ?? [];
  }, [t]);

  useEffect(() => {
    void load().then((all) => {
      const hit = wanted ? all.find((r) => r.id === wanted) : null;
      if (hit) setOpen(hit);
    });
  }, [load, wanted]);

  const close = () => {
    setOpen(null);
    if (wanted) setSearchParams((params) => { params.delete("open"); return params; }, { replace: true });
  };

  const shown = (requests ?? []).filter((r) => (filter === "open" ? r.status === "pending" || r.status === "failed" : filter === "all" ? true : r.status === filter));
  const columns: TableColumn<PayslipRequest>[] = [
    { key: "who", header: t("requests.employee"), render: (r) => <><strong>{r.fullName}</strong><HintText small>{r.email}</HintText></> },
    { key: "cycle", header: t("requests.cycle"), render: (r) => `${r.cycleTitle} · ${formatDateOnly(r.periodStart, i18n.language)} - ${formatDateOnly(r.periodEnd, i18n.language)}` },
    { key: "asked", header: t("requests.asked"), render: (r) => <>{formatDateOnly(r.createdAt.slice(0, 10), i18n.language)}{r.note ? <HintText small>{r.note}</HintText> : null}</> },
    { key: "status", header: t("requests.status"), render: (r) => (
      <>
        <StatusBadge status={BADGE[r.status]}>{r.sending ? t("requests.sending") : t(`requests.statuses.${r.status}`)}</StatusBadge>
        {r.status === "sent" && r.sentAt ? <HintText small>{t("requests.sentLine", { date: formatDateOnly(r.sentAt.slice(0, 10), i18n.language), by: r.handledBy ?? "", version: r.cycleVersion, serial: r.exportSerial })}</HintText> : null}
        {r.status === "rejected" && r.rejectionReason ? <HintText small>{t("requests.rejectedWith", { reason: r.rejectionReason })}</HintText> : null}
        {r.status === "failed" && r.lastError ? <HintText small>{r.lastError}</HintText> : null}
      </>
    ) },
    // owner 2026-11-12: one way to answer - the card with the preview, send and reject
    { key: "action", header: "", render: (r) => (
      <Button size="sm" variant={r.status === "pending" || r.status === "failed" ? "primary" : "ghost"} onClick={() => { setNotice(""); setOpen(r); }}>
        {r.status === "pending" || r.status === "failed" ? t("requests.review") : t("requests.view")}
      </Button>
    ) },
  ];

  return (
    <PageShell title={t("nav.requests")} subtitle={t("requests.hint")} wide>
      <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      <Card actions={<Select name="requestFilter" value={filter} onChange={(event) => setFilter(event.target.value)}
        options={["open", "pending", "failed", "sent", "rejected", "all"].map((v) => ({ value: v, label: t(`requests.filters.${v}`) }))} />}>
        <Table columns={columns} data={shown} getRowId={(r) => r.id} loading={requests === null} emptyMessage={t("requests.empty")} />
      </Card>
      <PayslipRequestModal request={open} onClose={close} onDone={(message) => { close(); setNotice(message); void load(); }} />
    </PageShell>
  );
}
