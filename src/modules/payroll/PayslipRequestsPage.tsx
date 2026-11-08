import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PayrollCycleRepository, { type PayslipRequest } from "../../core/repositories/PayrollCycleRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Select from "../../components/common/Select";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import { payrollError } from "./payrollUi";

const BADGE: Record<PayslipRequest["status"], string> = { pending: "pending", sent: "active", failed: "inactive" };

// Owner 2026-11-08: the payslip requests a manager may handle (their payroll scope only). One click
// sends the approved, stored payslip of the published version as a PDF to the employee's
// registered email; a failure stays open with its error and can be retried.
export default function PayslipRequestsPage() {
  const { t, i18n } = useTranslation("payroll");
  const navigate = useNavigate();
  const [requests, setRequests] = useState<PayslipRequest[] | null>(null);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<PayslipRequest | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await PayrollCycleRepository.listRequests(null);
    if (result.error) setError(payrollError(result.error, t));
    setRequests(result.data ?? []);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (request: PayslipRequest) => {
    setConfirm(null);
    setSending(request.id);
    setError("");
    setNotice("");
    const result = await PayrollCycleRepository.sendPayslip(request.id);
    setSending(null);
    if (result.error) setError(payrollError(result.error, t));
    else setNotice(t("requests.sentTo", { email: request.email, name: request.fullName }));
    await load();
  };

  const shown = (requests ?? []).filter((r) => (filter === "open" ? r.status !== "sent" : filter === "all" ? true : r.status === filter));
  const columns: TableColumn<PayslipRequest>[] = [
    { key: "who", header: t("requests.employee"), render: (r) => <><strong>{r.fullName}</strong><HintText small>{r.email}</HintText></> },
    { key: "cycle", header: t("requests.cycle"), render: (r) => `${r.cycleTitle} · ${formatDateOnly(r.periodStart, i18n.language)} - ${formatDateOnly(r.periodEnd, i18n.language)}` },
    { key: "asked", header: t("requests.asked"), render: (r) => <>{formatDateOnly(r.createdAt.slice(0, 10), i18n.language)}{r.note ? <HintText small>{r.note}</HintText> : null}</> },
    { key: "status", header: t("requests.status"), render: (r) => (
      <>
        <StatusBadge status={BADGE[r.status]}>{r.sending ? t("requests.sending") : t(`requests.statuses.${r.status}`)}</StatusBadge>
        {r.status === "sent" && r.sentAt ? <HintText small>{t("requests.sentLine", { date: formatDateOnly(r.sentAt.slice(0, 10), i18n.language), by: r.handledBy ?? "", version: r.cycleVersion, serial: r.exportSerial })}</HintText> : null}
        {r.status === "failed" && r.lastError ? <HintText small>{r.lastError}</HintText> : null}
      </>
    ) },
    { key: "action", header: "", render: (r) => (r.status === "sent" ? null : (
      <Button size="sm" loading={sending === r.id} disabled={r.sending || !r.cyclePublished || Boolean(sending)} onClick={() => setConfirm(r)}>
        {r.status === "failed" ? t("requests.retry") : t("requests.send")}
      </Button>
    )) },
  ];

  return (
    <PageShell title={t("nav.requests")} subtitle={t("requests.hint")} wide>
      <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
      <ErrorText>{error}</ErrorText>
      {notice ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{notice}</p> : null}
      <Card actions={<Select name="requestFilter" value={filter} onChange={(event) => setFilter(event.target.value)}
        options={["open", "pending", "failed", "sent", "all"].map((v) => ({ value: v, label: t(`requests.filters.${v}`) }))} />}>
        <Table columns={columns} data={shown} getRowId={(r) => r.id} loading={requests === null} emptyMessage={t("requests.empty")} />
      </Card>
      <Modal isOpen={Boolean(confirm)} onClose={() => setConfirm(null)} title={t("requests.confirmTitle")}
        footer={<Button onClick={() => confirm && send(confirm)}>{t("requests.send")}</Button>}>
        {confirm ? <HintText>{t("requests.confirmBody", { name: confirm.fullName, email: confirm.email, cycle: confirm.cycleTitle })}</HintText> : null}
      </Modal>
    </PageShell>
  );
}
