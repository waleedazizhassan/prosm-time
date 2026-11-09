import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import ExternalLaborRepository, { type RunDetail, type RunWorker } from "../../core/repositories/ExternalLaborRepository";
import { formatDateOnly, formatDateTime } from "../../core/utils/formatDate";
import savePdfDocument from "../../core/utils/savePdfDocument";
import { isRtl as directionIsRtl } from "../../i18n/direction";
import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import { money, saveXlsx } from "../payroll/payrollUi";
import { buildExternalPayPdf, buildExternalPayXlsx } from "./externalPayDocuments";
import { externalPayError } from "./externalPayUi";

const sumKind = (rows: { amount: number; kind: string }[], kind: string) => rows.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.amount), 0);

// 2026-11-08 B-07: one external labour pay run - quantities, the policy lines, individual
// adjustments, approval (a frozen snapshot) and reopening with a reason, and the exports.
export default function ExternalPayRunPage() {
  const { runId = "" } = useParams();
  const { t, i18n } = useTranslation("externalPay");
  const navigate = useNavigate();
  const location = useLocation();
  const rtl = directionIsRtl(i18n.language);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [siteFilter, setSiteFilter] = useState("");
  const [quantityFor, setQuantityFor] = useState<RunWorker | null>(null);
  const [quantity, setQuantity] = useState({ value: "", note: "" });
  const [adjustFor, setAdjustFor] = useState<RunWorker | null>(null);
  const [adjust, setAdjust] = useState({ kind: "deduction" as "deduction" | "addition", mode: "amount" as "amount" | "quantity", value: "", reason: "" });
  const [linesFor, setLinesFor] = useState<RunWorker | null>(null);
  const [reopen, setReopen] = useState<string | null>(null);
  const skipped = (location.state as { skipped?: { name: string; reason: string }[] } | null)?.skipped ?? [];

  const load = useCallback(async () => {
    const result = await ExternalLaborRepository.getRun(runId);
    if (result.error) setError(externalPayError(result.error, t));
    setDetail(result.data);
    if (result.data && linesFor) setLinesFor(result.data.workers.find((w) => w.runWorkerId === linesFor.runWorkerId) ?? null);
  }, [runId, t, linesFor]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const act = async (action: () => Promise<{ error: string | null }>, after?: () => void) => {
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    if (result.error) {
      setError(externalPayError(result.error, t));
      return;
    }
    after?.();
    await load();
  };

  const sites = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of detail?.workers ?? []) if (w.siteId) map.set(w.siteId, w.siteName ?? "");
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [detail]);
  const shown = (detail?.workers ?? []).filter((w) => !siteFilter || w.siteId === siteFilter);

  if (!detail) return <PageShell title="">{error ? <ErrorText>{error}</ErrorText> : <LoadingState />}</PageShell>;
  const draft = detail.run.isDraft;

  const exportFiles = async (format: "pdf" | "xlsx" | "statements", workers: RunWorker[]) => {
    if (workers.length === 0) return;
    setBusy(true);
    setError("");
    const logged = await ExternalLaborRepository.logExport(runId, format === "xlsx" ? "xlsx" : "pdf", workers.length);
    if (logged.error) {
      setBusy(false);
      setError(externalPayError(logged.error, t));
      return;
    }
    const base = `${t("doc.reportTitle")} ${detail.run.periodStart} ${detail.run.periodEnd}${workers.length === 1 ? ` ${workers[0].name}` : ""}${draft ? ` (${t("status.draft")})` : ""}`;
    try {
      if (format === "xlsx") await saveXlsx(`${base}.xlsx`, buildExternalPayXlsx(detail, workers, t, rtl));
      else {
        const doc = await buildExternalPayPdf(detail, workers, t, rtl, format === "statements");
        if (doc) await savePdfDocument(doc, `${base}.pdf`);
      }
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<RunWorker>[] = [
    { key: "name", header: t("run.worker"), render: (w) => <span><strong>{w.name}</strong>{w.workerNumber ? <span style={{ color: "var(--text-secondary)" }}> #{w.workerNumber}</span> : null}{w.siteName ? <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{w.siteName}</div> : null}</span> },
    { key: "rate", header: t("run.rate"), render: (w) => `${money(w.rate)} ${w.currency} / ${t(`unit.${w.unit}`)}` },
    {
      key: "quantity",
      header: t("run.quantity"),
      render: (w) => (
        <span>
          {w.quantity === null ? <span style={{ color: "var(--color-warning, #b45309)" }}>{t("run.quantityMissing")}</span> : `${w.quantity} ${t(`unitQuantity.${w.unit}`)}`}
          <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {w.unit === "HOURLY" || w.unit === "DAILY" ? t("run.kiosk", { hours: w.attendanceHours, days: w.attendanceDays }) : t("run.manualUnit")}
            {w.quantitySource === "manual" && w.quantityNote ? ` · ${w.quantityNote}` : ""}
          </div>
        </span>
      ),
    },
    { key: "gross", header: t("run.gross"), render: (w) => money(w.gross) },
    { key: "policy", header: t("run.policy"), render: (w) => `+${money(sumKind(w.policyLines, "addition"))} / -${money(sumKind(w.policyLines, "deduction"))}` },
    { key: "manual", header: t("run.manual"), render: (w) => (w.adjustments.length ? `+${money(sumKind(w.adjustments, "addition"))} / -${money(sumKind(w.adjustments, "deduction"))}` : "-") },
    { key: "net", header: t("run.net"), render: (w) => <strong>{w.net === null ? "-" : `${money(w.net)} ${w.currency}`}</strong> },
    {
      key: "actions",
      header: "",
      render: (w) => (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Button size="sm" variant="ghost" onClick={() => setLinesFor(w)}>{t("run.lines")}</Button>
          {draft && detail.can.manage ? (
            <Button size="sm" variant="ghost" onClick={() => { setQuantityFor(w); setQuantity({ value: w.quantity === null ? "" : String(w.quantity), note: w.quantityNote ?? "" }); }}>{t("run.setQuantity")}</Button>
          ) : null}
          {draft && detail.can.adjust ? (
            <Button size="sm" variant="ghost" onClick={() => { setAdjustFor(w); setAdjust({ kind: "deduction", mode: w.unit === "DAILY" || w.unit === "MONTHLY" || w.unit === "YEARLY" ? "quantity" : "amount", value: "", reason: "" }); }}>{t("run.adjust")}</Button>
          ) : null}
          {detail.can.export ? <Button size="sm" variant="ghost" onClick={() => exportFiles("statements", [w])}>{t("run.statement")}</Button> : null}
        </div>
      ),
    },
  ];

  const dayUnit = adjustFor && (adjustFor.unit === "DAILY" || adjustFor.unit === "MONTHLY" || adjustFor.unit === "YEARLY");

  return (
    <PageShell title={detail.run.title} subtitle={`${formatDateOnly(detail.run.periodStart, i18n.language)} - ${formatDateOnly(detail.run.periodEnd, i18n.language)} · ${detail.run.siteName ?? t("runs.allSites")}`} wide>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-3)" }}>
        <Button variant="ghost" onClick={() => navigate("/workers/pay")}>{t("run.back")}</Button>
        <StatusBadge status={draft ? "pending" : "active"}>{t(`status.${detail.run.status}`)} · v{detail.run.runVersion}</StatusBadge>
        {detail.run.approvedAt ? <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("run.approvedBy", { name: detail.run.approvedBy ?? "-", time: formatDateTime(detail.run.approvedAt, i18n.language) })}</span> : null}
        <span style={{ flex: 1 }} />
        {draft && detail.can.approve ? <Button loading={busy} onClick={() => act(() => ExternalLaborRepository.transition(runId, "approve", null, detail.run.rowVersion))}>{t("run.approve")}</Button> : null}
        {!draft && detail.can.approve ? <Button variant="ghost" onClick={() => setReopen("")}>{t("run.reopen")}</Button> : null}
        {draft && detail.can.manage && detail.run.runVersion === 1 ? (
          <Button variant="ghost" loading={busy} onClick={() => act(() => ExternalLaborRepository.transition(runId, "delete", null, detail.run.rowVersion), () => navigate("/workers/pay"))}>{t("run.delete")}</Button>
        ) : null}
      </div>
      {draft ? <HintText>{t("run.draftNote")}</HintText> : <HintText>{t("run.frozenNote")}</HintText>}
      {detail.run.reopenReason && draft ? <HintText small>{t("run.reopenedBecause", { reason: detail.run.reopenReason })}</HintText> : null}
      {skipped.length ? <HintText small>{t("runs.skipped", { names: skipped.map((s) => `${s.name} (${t(`skipReason.${s.reason}`)})`).join(", ") })}</HintText> : null}
      <ErrorText>{error}</ErrorText>

      <Card title={t("run.totals")}>
        {detail.totals.length === 0 ? <HintText>{t("run.noTotals")}</HintText> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))", gap: "var(--space-3)" }}>
            {detail.totals.map((total) => (
              <div key={total.currency} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("run.totalIn", { currency: total.currency, n: total.workers })}</div>
                <div style={{ fontSize: "var(--font-xl, 1.4rem)", fontWeight: 700 }}>{money(total.net)} {total.currency}</div>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("run.totalBreakdown", { gross: money(total.gross), additions: money(total.additions), deductions: money(total.deductions) })}</div>
              </div>
            ))}
          </div>
        )}
        <HintText small>{t("run.currencyNote")}</HintText>
      </Card>

      <Card title={t("run.workersTitle")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end", marginBottom: "var(--space-2)" }}>
          {sites.length > 1 ? (
            <div style={{ minWidth: 180 }}>
              <Select label={t("run.filterSite")} name="runSiteFilter" value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}
                options={[{ value: "", label: t("runs.allSites") }, ...sites.map((site) => ({ value: site.id, label: site.name }))]} />
            </div>
          ) : null}
          {detail.can.export ? (
            <>
              <Button variant="ghost" loading={busy} disabled={!shown.length} onClick={() => exportFiles("pdf", shown)}>{t("run.exportPdf")}</Button>
              <Button variant="ghost" loading={busy} disabled={!shown.length} onClick={() => exportFiles("statements", shown)}>{t("run.exportStatements")}</Button>
              <Button variant="ghost" loading={busy} disabled={!shown.length} onClick={() => exportFiles("xlsx", shown)}>{t("run.exportXlsx")}</Button>
            </>
          ) : null}
        </div>
        <Table columns={columns} data={shown} getRowId={(w) => w.runWorkerId} emptyMessage={t("run.empty")} />
      </Card>

      <Modal isOpen={quantityFor !== null} onClose={() => setQuantityFor(null)} title={t("run.quantityTitle", { name: quantityFor?.name ?? "" })}
        footer={<Button loading={busy} disabled={quantity.value === "" || Number(quantity.value) < 0} onClick={() => quantityFor && act(() => ExternalLaborRepository.setQuantity(quantityFor.runWorkerId, Number(quantity.value), quantity.note.trim() || null, quantityFor.rowVersion), () => setQuantityFor(null))}>{t("run.save")}</Button>}>
        {quantityFor ? (
          <>
            <HintText small>{t("run.quantityUnit", { unit: t(`unitQuantity.${quantityFor.unit}`) })}</HintText>
            {quantityFor.unit === "HOURLY" || quantityFor.unit === "DAILY" ? <HintText small>{t("run.kiosk", { hours: quantityFor.attendanceHours, days: quantityFor.attendanceDays })}</HintText> : null}
            <Input label={t("run.quantity")} name="quantityValue" type="number" value={quantity.value} onChange={(event) => setQuantity({ ...quantity, value: event.target.value })} />
            <Textarea label={t("run.quantityNote")} name="quantityNote" value={quantity.note} onChange={(event) => setQuantity({ ...quantity, note: event.target.value })} />
          </>
        ) : null}
      </Modal>

      <Modal isOpen={adjustFor !== null} onClose={() => setAdjustFor(null)} title={t("run.adjustTitle", { name: adjustFor?.name ?? "" })}
        footer={<Button loading={busy} disabled={!(Number(adjust.value) > 0) || adjust.reason.trim().length < 3} onClick={() => adjustFor && act(() => ExternalLaborRepository.addAdjustment(adjustFor.runWorkerId, adjust.kind, adjust.mode, Number(adjust.value), adjust.reason.trim()), () => setAdjustFor(null))}>{t("run.save")}</Button>}>
        {adjustFor ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-3)" }}>
              <Select label={t("run.adjustKind")} name="adjustKind" value={adjust.kind} onChange={(event) => setAdjust({ ...adjust, kind: event.target.value as "deduction" | "addition" })}
                options={[{ value: "deduction", label: t("adjustment.deduction") }, { value: "addition", label: t("adjustment.addition") }]} />
              <Select label={t("run.adjustMode")} name="adjustMode" value={adjust.mode} onChange={(event) => setAdjust({ ...adjust, mode: event.target.value as "amount" | "quantity" })}
                options={[{ value: "amount", label: t("run.byAmount", { currency: adjustFor.currency }) }, ...(dayUnit ? [{ value: "quantity", label: t("run.byDays") }] : [])]} />
              <Input label={adjust.mode === "quantity" ? t("run.days") : t("run.amountIn", { currency: adjustFor.currency })} name="adjustValue" type="number" value={adjust.value} onChange={(event) => setAdjust({ ...adjust, value: event.target.value })} />
            </div>
            <HintText small>{adjust.mode === "quantity" ? (adjustFor.unit === "DAILY" ? t("run.daysDaily") : t("run.daysConverted", { rule: t(`policy.basisOption.${detail.rules.dayRateBasis}`), divisor: detail.rules.fixedDivisor })) : dayUnit ? "" : t("run.amountOnlyUnit")}</HintText>
            <Textarea label={t("run.reason")} name="adjustReason" value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} />
          </>
        ) : null}
      </Modal>

      <Modal isOpen={linesFor !== null} onClose={() => setLinesFor(null)} title={t("run.linesTitle", { name: linesFor?.name ?? "" })} size="lg">
        {linesFor ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--font-sm)" }}>
            <tbody>
              <tr><td>{t("run.gross")}</td><td style={{ textAlign: "end" }}>{money(linesFor.gross)} {linesFor.currency}</td><td /></tr>
              {linesFor.policyLines.map((line) => (
                <tr key={`p-${line.name}`}><td>{line.kind === "addition" ? "+" : "-"} {line.name} <span style={{ color: "var(--text-secondary)" }}>({t("run.policyLine")})</span></td><td style={{ textAlign: "end" }}>{money(line.amount)}</td><td /></tr>
              ))}
              {linesFor.adjustments.map((adj) => (
                <tr key={adj.id}>
                  <td>{adj.kind === "addition" ? "+" : "-"} {t(`adjustment.${adj.kind}`)} <span style={{ color: "var(--text-secondary)" }}>({t("run.manualLine")}{adj.quantity ? ` · ${adj.quantity} ${t("unitQuantity.DAILY")}` : ""} · {adj.reason} · {adj.createdBy ?? ""})</span></td>
                  <td style={{ textAlign: "end" }}>{money(adj.amount)}</td>
                  <td>{draft && detail.can.adjust ? <Button size="sm" variant="ghost" loading={busy} onClick={() => act(() => ExternalLaborRepository.deleteAdjustment(adj.id))}>{t("run.remove")}</Button> : null}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}><td>{t("run.net")}</td><td style={{ textAlign: "end" }}>{money(linesFor.net)} {linesFor.currency}</td><td /></tr>
            </tbody>
          </table>
        ) : null}
      </Modal>

      <Modal isOpen={reopen !== null} onClose={() => setReopen(null)} title={t("run.reopenTitle")}
        footer={<Button loading={busy} disabled={(reopen ?? "").trim().length < 3} onClick={() => act(() => ExternalLaborRepository.transition(runId, "reopen", (reopen ?? "").trim(), detail.run.rowVersion), () => setReopen(null))}>{t("run.reopen")}</Button>}>
        <HintText small>{t("run.reopenHint")}</HintText>
        <Textarea label={t("run.reason")} name="reopenReason" value={reopen ?? ""} onChange={(event) => setReopen(event.target.value)} />
      </Modal>
    </PageShell>
  );
}
