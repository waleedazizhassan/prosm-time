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
import Select from "../../components/common/Select";
import PayslipLines from "./PayslipLines";
import Modal from "../../components/common/Modal";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import illustration from "../../assets/illustrations/allowances.svg";
import { payrollError } from "./payrollUi";
import usePayrollDigits from "./usePayrollDigits";
import { buildOnePayslipPdf } from "./payrollDocuments";
import SuccessText from "../../components/common/SuccessText";

// Owner 2026-11-08: "My payslips" - the person's own published payslips (locked cycles only). They
// are viewed in the app when the organisation allows it, and can always be asked for by email: an
// allowed manager then sends the approved, stored version as a PDF to the registered email.
export default function MyPayslipsPage() {
  const { t, i18n } = useTranslation("payroll");
  usePayrollDigits();
  const isRtl = i18n.dir() === "rtl";
  const [data, setData] = useState<{ canViewInApp: boolean; email: string | null; cycles: MyPayslipCycle[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // owner 2026-11-12: one clear "request payslip" button - choose the month, add a note, send
  const [asking, setAsking] = useState(false);
  const [askCycle, setAskCycle] = useState("");
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
    if (!askCycle) return;
    setBusy("ask");
    setError("");
    const result = await PayrollCycleRepository.requestPayslip(askCycle, note.trim() || null);
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else setNotice(t("mine.asked"));
    setAsking(false);
    setNote("");
    await load();
  };

  // a month can be asked for unless a request for it is still open
  const askable = (data?.cycles ?? []).filter((c) => !c.request || c.request.status === "rejected" || c.request.status === "sent");

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
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      {data && data.cycles.length > 0 ? (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <Button disabled={askable.length === 0} onClick={() => { setAskCycle(askable[0]?.cycleId ?? ""); setNote(""); setAsking(true); }}>{t("mine.requestButton")}</Button>
          {askable.length === 0 ? <HintText small>{t("mine.allAsked")}</HintText> : null}
        </div>
      ) : null}
      {data === null ? <LoadingState /> : data.cycles.length === 0 ? <EmptyState message={t("mine.empty")} /> : null}
      {data?.cycles.map((cycle) => {
        return (
          <Card key={cycle.cycleId} title={cycle.title} subtitle={`${formatDateOnly(cycle.periodStart, i18n.language)} - ${formatDateOnly(cycle.periodEnd, i18n.language)} · v${cycle.cycleVersion}`}>
            {cycle.request ? (
              <HintText small>
                <StatusBadge status={cycle.request.status === "sent" ? "active" : cycle.request.status === "rejected" ? "revoked" : cycle.request.status === "failed" ? "inactive" : "pending"}>{t(`mine.statuses.${cycle.request.status}`)}</StatusBadge>
                {cycle.request.status === "rejected" && cycle.request.reason ? ` ${t("mine.rejectedReason", { reason: cycle.request.reason })}` : ""}
                {cycle.request.status === "sent" && cycle.request.sentAt ? ` ${t("mine.sentOn", { date: formatDateOnly(cycle.request.sentAt.slice(0, 10), i18n.language), email: data.email ?? "" })}` : ""}
              </HintText>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {data.canViewInApp || cycle.canView ? <Button size="sm" loading={busy === `view-${cycle.cycleId}`} onClick={() => view(cycle)}>{t("mine.view")}</Button> : null}
            </div>
          </Card>
        );
      })}

      <Modal isOpen={asking} onClose={() => setAsking(false)} title={t("mine.requestButton")} footer={<Button loading={busy === "ask"} disabled={!askCycle} onClick={ask}>{t("mine.send")}</Button>}>
        <HintText>{t("mine.askBodyBoth")}</HintText>
        <Select label={t("mine.whichMonth")} name="payslipCycle" value={askCycle} onChange={(event) => setAskCycle(event.target.value)}
          options={askable.map((c) => ({ value: c.cycleId, label: `${c.title} · ${formatDateOnly(c.periodStart, i18n.language)} - ${formatDateOnly(c.periodEnd, i18n.language)}` }))} />
        <Input label={t("mine.note")} name="payslipNote" value={note} onChange={(event) => setNote(event.target.value)} />
      </Modal>

      <Modal isOpen={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing ? `${t("reports.payslip")} · ${viewing.cycle.title}` : ""} size="lg"
        footer={<Button loading={busy === "pdf"} onClick={download}>{t("mine.download")}</Button>}>
        {viewing ? <PayslipLines payslip={viewing} /> : null}
      </Modal>
    </PageShell>
  );
}
