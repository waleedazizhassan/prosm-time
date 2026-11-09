import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import PayrollCycleRepository, { type MyPayslip, type MyPayslipCycle } from "../../core/repositories/PayrollCycleRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import savePdfDocument, { exportFileName } from "../../core/utils/savePdfDocument";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import illustration from "../../assets/illustrations/allowances.svg";
import { money, payrollError } from "./payrollUi";
import { buildOnePayslipPdf } from "./payrollDocuments";

// Owner 2026-11-08: "My payslips" - the person's own published payslips (locked cycles only). They
// are viewed in the app when the organisation allows it, and can always be asked for by email: an
// allowed manager then sends the approved, stored version as a PDF to the registered email.
export default function MyPayslipsPage() {
  const { t, i18n } = useTranslation("payroll");
  const isRtl = i18n.dir() === "rtl";
  const [data, setData] = useState<{ canViewInApp: boolean; email: string | null; cycles: MyPayslipCycle[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [asking, setAsking] = useState<MyPayslipCycle | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [viewing, setViewing] = useState<MyPayslip | null>(null);

  const load = useCallback(async () => {
    const result = await PayrollCycleRepository.myPayslipCycles();
    if (result.error) setError(payrollError(result.error, t));
    setData(result.data ?? { canViewInApp: false, email: null, cycles: [] });
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const ask = async () => {
    if (!asking) return;
    setBusy("ask");
    setError("");
    const result = await PayrollCycleRepository.requestPayslip(asking.cycleId, note.trim() || null);
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else setNotice(t("mine.asked"));
    setAsking(null);
    setNote("");
    await load();
  };

  const view = async (cycle: MyPayslipCycle) => {
    setBusy(`view-${cycle.cycleId}`);
    const result = await PayrollCycleRepository.myPayslip(cycle.cycleId);
    setBusy("");
    if (result.error || !result.data) setError(payrollError(result.error, t));
    else setViewing(result.data);
  };

  const download = async () => {
    if (!viewing) return;
    setBusy("pdf");
    try {
      const doc = await buildOnePayslipPdf({
        reportType: "payslip", serial: null, draft: false,
        cycle: { id: "", title: viewing.cycle.title, periodStart: viewing.cycle.periodStart, periodEnd: viewing.cycle.periodEnd, status: "locked", cycleVersion: viewing.cycle.cycleVersion, siteName: null },
        organization: viewing.organization, settings: { taxNotice: viewing.settings.taxNotice, footerNote: viewing.settings.footerNote, showSignatures: false, language: "bilingual" },
        employees: [viewing.employee], excluded: [], totals: [],
      }, t, isRtl);
      await savePdfDocument(doc, exportFileName(t("reports.payslip"), viewing.cycle.title, `v${viewing.cycle.cycleVersion}`));
    } catch {
      setError(t("errors.fileFailed"));
    }
    setBusy("");
  };

  return (
    <PageShell title="">
      <PageBanner pageId="payslips" illustration={illustration} />
      <ErrorText>{error}</ErrorText>
      {notice ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{notice}</p> : null}
      {data === null ? <LoadingState /> : data.cycles.length === 0 ? <EmptyState message={t("mine.empty")} /> : null}
      {data?.cycles.map((cycle) => {
        const open = cycle.request && cycle.request.status !== "sent";
        return (
          <Card key={cycle.cycleId} title={cycle.title} subtitle={`${formatDateOnly(cycle.periodStart, i18n.language)} - ${formatDateOnly(cycle.periodEnd, i18n.language)} · v${cycle.cycleVersion}`}>
            {cycle.request ? (
              <HintText small>
                <StatusBadge status={cycle.request.status === "sent" ? "active" : cycle.request.status === "failed" ? "inactive" : "pending"}>{t(`mine.statuses.${cycle.request.status}`)}</StatusBadge>
                {cycle.request.status === "sent" && cycle.request.sentAt ? ` ${t("mine.sentOn", { date: formatDateOnly(cycle.request.sentAt.slice(0, 10), i18n.language), email: data.email ?? "" })}` : ""}
              </HintText>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {data.canViewInApp || cycle.canView ? <Button size="sm" loading={busy === `view-${cycle.cycleId}`} onClick={() => view(cycle)}>{t("mine.view")}</Button> : null}
              {data.canViewInApp || cycle.canView ? null : (
                <Button size="sm" variant="ghost" disabled={Boolean(open)} onClick={() => { setAsking(cycle); setNote(""); }}>{open ? t("mine.waiting") : t("mine.ask")}</Button>
              )}
            </div>
          </Card>
        );
      })}

      <Modal isOpen={Boolean(asking)} onClose={() => setAsking(null)} title={t("mine.ask")} footer={<Button loading={busy === "ask"} onClick={ask}>{t("mine.send")}</Button>}>
        <HintText>{t("mine.askBodyApp")}</HintText>
        <Input label={t("mine.note")} name="payslipNote" value={note} onChange={(event) => setNote(event.target.value)} />
      </Modal>

      <Modal isOpen={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing ? `${t("reports.payslip")} · ${viewing.cycle.title}` : ""} size="lg"
        footer={<Button loading={busy === "pdf"} onClick={download}>{t("mine.download")}</Button>}>
        {viewing ? (
          <div>
            {(["earning", "allowance", "deduction", "installment"] as const).map((category) => {
              const lines = viewing.employee.lines.filter((l) => l.category === category);
              if (lines.length === 0) return null;
              return (
                <div key={category} style={{ marginBottom: "var(--space-2)" }}>
                  <h4 style={{ margin: "0 0 4px" }}>{t(`categories.${category}`)}</h4>
                  {lines.map((l) => (
                    <div key={l.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-sm)", padding: "3px 0", borderBottom: "1px solid var(--border-light)" }}>
                      <span>{isRtl ? l.name_ar : l.name_en || l.name_ar}</span><span>{money(l.amount)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: "var(--font-lg)", marginTop: "var(--space-2)" }}>
              <span>{t("doc.net")}</span><span>{money(viewing.employee.net_salary)} {viewing.employee.currency}</span>
            </div>
          </div>
        ) : null}
      </Modal>
    </PageShell>
  );
}
