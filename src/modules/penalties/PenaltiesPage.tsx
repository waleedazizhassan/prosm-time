import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Tabs from "../../components/common/Tabs";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import Input from "../../components/common/Input";
import Textarea from "../../components/common/Textarea";
import Modal from "../../components/common/Modal";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";
import { useAuth } from "../../core/context/AuthContext";
import PenaltiesRepository, { type Incentive, type Violation } from "../../core/repositories/PenaltiesRepository";
import ViolationDetailModal from "./ViolationDetailModal";
import { GrantIncentiveModal, RecordViolationModal } from "./RecordModals";
import { actionText, incentiveValueText, money, STATUS_BADGE, violationName } from "./penaltyUi";

type View = "action" | "violations" | "incentives";
const DECIDE = ["investigate", "approve", "reduce", "reject", "appeal_confirm", "appeal_cancel"];
const INCENTIVE_BADGE: Record<Incentive["status"], string> = { pending_approval: "pending", approved: "active", rejected: "revoked", cancelled: "deactivated" };

// HR suite feature 1: the day-to-day follow-up - what waits for the reader (investigate, approve, decide an
// appeal), every violation they may see, and the incentives. A manager records a violation or proposes an
// incentive from here (or from the phone).
export default function PenaltiesPage() {
  const { t, i18n } = useTranslation("penalties");
  const navigate = useNavigate();
  const { profile, hasPermission } = useAuth();
  const isAdmin = Boolean(profile?.isOwner) || hasPermission("hr.manage");
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Violation[] | null>(null);
  const [incentives, setIncentives] = useState<Incentive[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [record, setRecord] = useState(false);
  const [grant, setGrant] = useState(false);
  const [incentiveAct, setIncentiveAct] = useState<{ row: Incentive; action: "reject" | "cancel" } | null>(null);
  const [incentiveNote, setIncentiveNote] = useState("");
  const [busy, setBusy] = useState("");
  const openId = params.get("open");
  const view = (params.get("tab") as View | null) ?? "action";

  const load = useCallback(async () => {
    const [v, i] = await Promise.all([PenaltiesRepository.list(), PenaltiesRepository.incentives()]);
    if (v.error || i.error) setError(humanizeBackendError(v.error ?? i.error, t) ?? t("loadError"));
    setRows((v.data ?? []).filter((r) => r.userId !== profile?.id));
    setIncentives((i.data ?? []).filter((r) => r.userId !== profile?.id));
  }, [t, profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const setView = (next: View) => setParams((p) => { p.set("tab", next); p.delete("open"); return p; }, { replace: true });
  const open = (id: string | null) => setParams((p) => { if (id) p.set("open", id); else p.delete("open"); return p; }, { replace: true });

  const q = search.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const waiting = useMemo(() => (rows ?? []).filter((r) => r.actions.some((a) => DECIDE.includes(a))), [rows]);
  const incentivesWaiting = (incentives ?? []).filter((i) => i.canAct);
  const shown = (view === "action" ? waiting : rows ?? []).filter((r) => match(`${r.name} ${violationName(t, r)}`));

  const columns: TableColumn<Violation>[] = [
    { key: "name", header: t("columns.person"), render: (r) => <strong>{r.name}</strong>, sortValue: (r) => r.name },
    { key: "violation", header: t("columns.violation"), render: (r) => violationName(t, r), sortValue: (r) => violationName(t, r) },
    { key: "date", header: t("columns.date"), render: (r) => formatDateOnly(r.occurredOn, i18n.language), sortValue: (r) => r.occurredOn },
    { key: "occurrence", header: t("columns.occurrence"), render: (r) => r.occurrence, sortValue: (r) => r.occurrence },
    { key: "penalty", header: t("columns.penalty"), render: (r) => actionText(t, r.finalAction, i18n.language) },
    { key: "amount", header: t("columns.amount"), render: (r) => (r.amount != null ? money(r.amount, i18n.language) : r.finalAction.kind === "deduction" ? t("actionOnly") : "—") },
    { key: "status", header: t("columns.status"), render: (r) => <StatusBadge status={STATUS_BADGE[r.status]}>{t(`status.${r.status}`)}</StatusBadge>, sortValue: (r) => r.status },
  ];

  const actIncentive = async (row: Incentive, action: "approve" | "reject" | "cancel", note: string | null) => {
    setBusy(row.id + action);
    setError("");
    const r = await PenaltiesRepository.actIncentive(row.id, action, note);
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    setIncentiveAct(null);
    setNotice(t(`incentive.done.${action}`));
    await load();
  };

  const incentiveColumns: TableColumn<Incentive>[] = [
    { key: "name", header: t("columns.person"), render: (r) => <strong>{r.name}</strong>, sortValue: (r) => r.name },
    { key: "reason", header: t("columns.reason"), render: (r) => (r.templateKey && !r.ruleName ? t(`incentiveTemplates.${r.templateKey}`) : r.reason) },
    { key: "value", header: t("columns.value"), render: (r) => `${incentiveValueText(t, r.amountType, r.value, i18n.language)}${r.amount != null ? ` · ${money(r.amount, i18n.language)}` : ""}` },
    { key: "date", header: t("columns.date"), render: (r) => formatDateOnly(r.createdAt, i18n.language), sortValue: (r) => r.createdAt },
    { key: "status", header: t("columns.status"), render: (r) => <StatusBadge status={INCENTIVE_BADGE[r.status]}>{t(`incentiveStatus.${r.status}`)}</StatusBadge> },
    {
      key: "do", header: "", render: (r) => (
        <span style={{ display: "inline-flex", gap: 6 }}>
          {r.canAct ? <Button size="xs" loading={busy === r.id + "approve"} onClick={() => void actIncentive(r, "approve", null)}>{t("do.approve")}</Button> : null}
          {r.canAct ? <Button size="xs" variant="ghost" onClick={() => { setIncentiveNote(""); setIncentiveAct({ row: r, action: "reject" }); }}>{t("do.reject")}</Button> : null}
          {r.canCancel && !r.canAct ? <Button size="xs" variant="ghost" onClick={() => { setIncentiveNote(""); setIncentiveAct({ row: r, action: "cancel" }); }}>{t("do.cancel")}</Button> : null}
        </span>
      ),
    },
  ];

  return (
    <PageShell title={t("pageTitle")}
      actions={(
        <>
          <Button size="sm" onClick={() => setRecord(true)}>{t("record.button")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setGrant(true)}>{t("incentive.button")}</Button>
          {isAdmin ? <Button size="sm" variant="ghost" onClick={() => navigate("/penalties/bylaw")}>{t("bylawLink")}</Button> : null}
        </>
      )}>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      <Card>
        <Tabs items={[
          { key: "action" as View, label: t("tabs.action"), badge: (waiting.length + incentivesWaiting.length) || undefined },
          { key: "violations" as View, label: t("tabs.violations") },
          { key: "incentives" as View, label: t("tabs.incentives"), badge: incentivesWaiting.length || undefined },
        ]} active={view} label={t("pageTitle")} onChange={setView} />
        <div style={{ maxWidth: 320, margin: "var(--space-2) 0" }}>
          <Input label={t("search")} name="penaltySearch" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {view !== "incentives" ? (
          <Table columns={columns} data={shown} getRowId={(r) => r.id} loading={!rows} grid onRowClick={(r) => open(r.id)}
            emptyMessage={view === "action" ? t("nothingWaiting") : t("noViolations")} />
        ) : null}
        {view === "action" && incentivesWaiting.length > 0 ? (
          <div style={{ marginTop: "var(--space-3)" }}>
            <h3 style={{ margin: "0 0 var(--space-2)" }}>{t("tabs.incentives")}</h3>
            <Table columns={incentiveColumns} data={incentivesWaiting} getRowId={(r) => r.id} emptyMessage="" />
          </div>
        ) : null}
        {view === "incentives" ? (
          <Table columns={incentiveColumns} data={(incentives ?? []).filter((r) => match(`${r.name} ${r.reason}`))} getRowId={(r) => r.id} loading={!incentives} grid
            emptyMessage={t("noIncentives")} />
        ) : null}
      </Card>

      <ViolationDetailModal id={openId} onClose={() => open(null)} onChanged={() => void load()} />
      <RecordViolationModal open={record} onClose={() => setRecord(false)} onDone={() => { setRecord(false); setNotice(t("record.done")); void load(); }} />
      <GrantIncentiveModal open={grant} onClose={() => setGrant(false)} onDone={() => { setGrant(false); setNotice(t("incentive.done.proposed")); void load(); }} />
      <Modal isOpen={Boolean(incentiveAct)} onClose={() => setIncentiveAct(null)} title={incentiveAct ? t(`do.${incentiveAct.action}`) : ""} size="sm"
        footer={<Button variant="danger" fullWidth loading={Boolean(busy)} onClick={() => incentiveAct && void actIncentive(incentiveAct.row, incentiveAct.action, incentiveNote.trim())}>{incentiveAct ? t(`do.${incentiveAct.action}`) : ""}</Button>}>
        <Textarea label={t("noteReason")} name="incentiveNote" value={incentiveNote} onChange={(e) => setIncentiveNote(e.target.value)} rows={2} />
      </Modal>
    </PageShell>
  );
}
