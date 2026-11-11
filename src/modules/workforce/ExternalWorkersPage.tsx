import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import { Copy } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import SiteWorkerRepository, { type ExternalWorker } from "../../core/repositories/SiteWorkerRepository";
import ExternalLaborRepository, { type ExternalRate, type RateUnit } from "../../core/repositories/ExternalLaborRepository";
import Select from "../../components/common/Select";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatTimeOnly } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import StatusBadge from "../../components/common/StatusBadge";
import Table, { type TableColumn } from "../../components/common/Table";
import Modal from "../../components/common/Modal";
import workersArt from "../../assets/illustrations/workers.svg";
import HintText from "../../components/common/HintText";
import useConfirm from "../../components/common/useConfirm";
import FieldRow from "../../components/common/FieldRow";

// Owner 2026-10-18/19: external workers (contractors without an app
// account) are added here for the whole organisation. The app generates
// each worker's 6-digit number; the worker clocks in and out with it at
// the kiosk of any site. Owner and sites.manage only (checked server-side).
export default function ExternalWorkersPage() {
  const { t, i18n } = useTranslation(["workforce", "externalPay"]);
  const [confirm, confirmDialog] = useConfirm();
  const { profile, hasPermission } = useAuth();
  const navigate = useNavigate();
  const allowed = Boolean(profile?.isOwner) || hasPermission("sites.manage");

  const [workers, setWorkers] = useState<ExternalWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [contractor, setContractor] = useState("");
  // 2026-11-09 (owner): the pay is set when the worker is added - an amount per hour, day, week, month or year
  const canSetPay = Boolean(profile?.isOwner) || hasPermission("external_labor.manage");
  const canSeePay = canSetPay || hasPermission("external_labor.view_pay");
  const [rates, setRates] = useState<Record<string, ExternalRate | null>>({});
  const [rateAmount, setRateAmount] = useState("");
  const [rateUnit, setRateUnit] = useState<RateUnit>("DAILY");
  const [rateCurrency, setRateCurrency] = useState("EGP");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [added, setAdded] = useState<{ name: string; number: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<{ workerId: string; reason: string } | null>(null);
  const [rowError, setRowError] = useState("");
  // Owner 2026-10-21: edit a worker's name and contractor, or delete one added by mistake.
  // owner 2026-11-11: editing a worker includes their pay - a higher or lower day rate, or another period (weekly, monthly...)
  const [editing, setEditing] = useState<{ worker: ExternalWorker; name: string; contractor: string; rate: string; unit: RateUnit; currency: string; from: string } | null>(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await SiteWorkerRepository.listExternal();
    setLoading(false);
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      return;
    }
    setLoadError("");
    setWorkers(result.data ?? []);
    // 2026-11-09: each worker's current pay, for those who may see it
    if (canSeePay) {
      const rates = await ExternalLaborRepository.listRates();
      setRates(Object.fromEntries((rates.data ?? []).map((r) => [r.workerId, r.current])));
    }
  }, [t, canSeePay]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // owner 2026-11-09: whoever only sees the pay lands on it
  const seesPay = Boolean(profile?.isOwner) || hasPermission("external_labor.view_pay");
  if (!allowed) return <Navigate to={seesPay ? "/workers/pay" : "/dashboard"} replace />;

  const handleAdd = async () => {
    setAdding(true);
    setAddError("");
    setCopied(false);
    const result = await SiteWorkerRepository.createExternal(name.trim(), contractor.trim() || null);
    setAdding(false);
    if (!result.success || !result.data) {
      setAddError(humanizeBackendError(result.message, t) ?? t("addError"));
      return;
    }
    if (canSetPay && rateAmount.trim() !== "" && Number(rateAmount) > 0) {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const rate = await ExternalLaborRepository.setRate(result.data.workerId, Number(rateAmount), rateCurrency.trim().toUpperCase() || "EGP", rateUnit, iso);
      if (rate.error) setAddError(t("externalPay:addRateFailed", { error: humanizeBackendError(rate.error, t) ?? rate.error }));
    }
    setAdded({ name: name.trim(), number: result.data.workerNumber });
    setName("");
    setContractor("");
    setRateAmount("");
    void load();
  };

  const handleCopy = async () => {
    if (!added) return;
    try {
      await navigator.clipboard.writeText(added.number);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const setStatus = async (worker: ExternalWorker, status: "active" | "inactive") => {
    setBusyId(worker.id);
    setRowError("");
    const result = await SiteWorkerRepository.updateExternal(worker.id, worker.fullName, worker.contractorName, status);
    setBusyId(null);
    if (!result.success) {
      setRowError(humanizeBackendError(result.message, t) ?? t("updateError"));
      return;
    }
    void load();
  };

  const saveEdit = async () => {
    if (!editing || !editing.name.trim()) return;
    setSavingEdit(true);
    setEditError("");
    const result = await SiteWorkerRepository.updateExternal(editing.worker.id, editing.name.trim(), editing.contractor.trim() || null, editing.worker.status);
    setSavingEdit(false);
    if (!result.success) {
      setEditError(humanizeBackendError(result.message, t) ?? t("updateError"));
      return;
    }
    const current = rates[editing.worker.id];
    const rateChanged = canSetPay && editing.rate.trim() !== "" && Number(editing.rate) > 0
      && (!current || Number(current.amount) !== Number(editing.rate) || current.unit !== editing.unit || current.currency !== editing.currency.trim().toUpperCase());
    if (rateChanged) {
      setSavingEdit(true);
      const rate = await ExternalLaborRepository.setRate(editing.worker.id, Number(editing.rate), editing.currency.trim().toUpperCase() || "EGP", editing.unit, editing.from);
      setSavingEdit(false);
      if (rate.error) {
        setEditError(humanizeBackendError(rate.error, t) ?? rate.error);
        void load();
        return;
      }
    }
    setEditing(null);
    void load();
  };

  const removeWorker = async (worker: ExternalWorker) => {
    if (!(await confirm(t("deleteConfirm", { name: worker.fullName })))) return;
    setBusyId(worker.id);
    setRowError("");
    const result = await SiteWorkerRepository.deleteExternal(worker.id);
    setBusyId(null);
    if (!result.success) {
      setRowError(humanizeBackendError(result.message, t) ?? t("updateError"));
      return;
    }
    void load();
  };

  const handleOverride = async () => {
    if (!overrideDraft || !overrideDraft.reason.trim()) return;
    setBusyId(overrideDraft.workerId);
    setRowError("");
    const result = await SiteWorkerRepository.adminClockOut(overrideDraft.workerId, overrideDraft.reason.trim());
    setBusyId(null);
    if (!result.success) {
      setRowError(humanizeBackendError(result.message, t) ?? t("updateError"));
      return;
    }
    setOverrideDraft(null);
    void load();
  };

  const columns: TableColumn<ExternalWorker>[] = [
    { key: "name", header: t("columns.name"), render: (worker) => worker.fullName },
    { key: "number", header: t("columns.number"), render: (worker) => <span style={{ fontFamily: "monospace", letterSpacing: "0.12em" }}>{worker.workerNumber}</span> },
    { key: "contractor", header: t("columns.contractor"), render: (worker) => worker.contractorName ?? "—" },
    ...(canSeePay ? [{ key: "pay", header: t("externalPay:addRate"), render: (worker: ExternalWorker) => {
      const r = rates[worker.id];
      return r ? `${r.amount} ${r.currency} / ${t(`externalPay:unit.${r.unit}`)}` : "—";
    } }] : []),
    {
      key: "now",
      header: t("columns.now"),
      render: (worker) =>
        worker.currentSiteName ? (
          <span>
            {t("atSite", { site: worker.currentSiteName })}
            {worker.clockedInAt ? <span style={{ color: "var(--text-secondary)" }}> · {formatTimeOnly(worker.clockedInAt, i18n.language)}</span> : null}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      header: t("columns.status"),
      render: (worker) => <StatusBadge status={worker.status === "active" ? "active" : "neutral"}>{t(`status.${worker.status}`)}</StatusBadge>,
    },
    {
      key: "actions",
      header: t("columns.actions"),
      render: (worker) => (
        <span style={{ display: "inline-flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {worker.currentSiteName ? (
            <Button variant="ghost" size="xs" onClick={() => setOverrideDraft({ workerId: worker.id, reason: "" })} disabled={busyId === worker.id}>
              {t("clockOutAction")}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => setEditing({ worker, name: worker.fullName, contractor: worker.contractorName ?? "",
            rate: rates[worker.id] ? String(rates[worker.id]!.amount) : "", unit: (rates[worker.id]?.unit as RateUnit | undefined) ?? "DAILY",
            currency: rates[worker.id]?.currency ?? "EGP", from: new Date().toLocaleDateString("en-CA") })} disabled={busyId === worker.id}>
            {t("editAction")}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setStatus(worker, worker.status === "active" ? "inactive" : "active")} loading={busyId === worker.id}>
            {worker.status === "active" ? t("deactivateAction") : t("activateAction")}
          </Button>
          <Button variant="danger" size="xs" onClick={() => removeWorker(worker)} disabled={busyId === worker.id}>
            {t("deleteAction")}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <PageShell title="">
      <PageBanner pageId="workers" illustration={workersArt} />
      {/* Owner 2026-11-09: the workers and their pay are one place */}
      {seesPay ? (
        <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <Button role="tab" aria-selected>{t("externalPay:views.workers")}</Button>
          <Button role="tab" variant="ghost" onClick={() => navigate("/workers/pay")}>{t("externalPay:payTab")}</Button>
        </div>
      ) : null}
      {confirmDialog}

      <Card title={t("addTitle")}>
        <HintText>{t("addHint")}</HintText>
        <FieldRow style={{ gap: "var(--space-2)" }}>
          <div style={{ minWidth: 200, flex: "1 1 200px" }}>
            <Input label={t("nameLabel")} name="workerName" value={name} onChange={(event) => setName(event.target.value)} disabled={adding} />
          </div>
          <div style={{ minWidth: 180, flex: "1 1 180px" }}>
            <Input label={t("contractorLabel")} name="workerContractor" value={contractor} onChange={(event) => setContractor(event.target.value)} disabled={adding} />
          </div>
          {canSetPay ? (
            <>
              <div style={{ minWidth: 120, flex: "0 1 140px" }}>
                <Input label={t("externalPay:addRate")} name="workerRate" type="number" value={rateAmount} onChange={(event) => setRateAmount(event.target.value)} disabled={adding} />
              </div>
              <div style={{ minWidth: 120, flex: "0 1 140px" }}>
                <Select label={t("externalPay:rates.unit")} name="workerRateUnit" value={rateUnit} onChange={(event) => setRateUnit(event.target.value as RateUnit)} disabled={adding}
                  options={(["DAILY", "WEEKLY", "MONTHLY", "HOURLY", "YEARLY"] as RateUnit[]).map((u) => ({ value: u, label: t(`externalPay:unit.${u}`) }))} />
              </div>
              <div style={{ minWidth: 90, flex: "0 1 100px" }}>
                <Input label={t("externalPay:rates.currency")} name="workerRateCurrency" value={rateCurrency} onChange={(event) => setRateCurrency(event.target.value.toUpperCase().slice(0, 3))} disabled={adding} />
              </div>
            </>
          ) : null}
          <Button onClick={handleAdd} loading={adding} disabled={!name.trim() || adding}>
            {t("addAction")}
          </Button>
        </FieldRow>
        <ErrorText>{addError}</ErrorText>
        {added ? (
          <div role="status" style={{ marginTop: "var(--space-3)", padding: "var(--space-3)", borderRadius: 12, background: "var(--brand-primary-subtle, #f0fdf4)", border: "1px solid var(--brand-primary-subtle-border, #86efac)" }}>
            <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("addedFor", { name: added.name })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: 6 }}>
              <span style={{ fontSize: "1.75rem", fontWeight: "var(--font-weight-bold)", fontFamily: "monospace", letterSpacing: "0.2em", color: "var(--text-primary)" }}>{added.number}</span>
              <Button variant="ghost" size="xs" onClick={handleCopy}>
                <Copy size={14} /> {copied ? t("copied") : t("copyAction")}
              </Button>
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)", marginTop: 4 }}>{t("addedHint")}</div>
          </div>
        ) : null}
      </Card>

      <Card title={t("listTitle")}>
        <ErrorText>{loadError || rowError}</ErrorText>
        {overrideDraft ? (
          <FieldRow style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <div style={{ minWidth: 240, flex: "1 1 240px" }}>
              <Input
                label={t("overrideReasonLabel")}
                name="overrideReason"
                value={overrideDraft.reason}
                onChange={(event) => setOverrideDraft({ ...overrideDraft, reason: event.target.value })}
              />
            </div>
            <Button onClick={handleOverride} disabled={!overrideDraft.reason.trim()} loading={busyId === overrideDraft.workerId}>
              {t("clockOutAction")}
            </Button>
            <Button variant="ghost" onClick={() => setOverrideDraft(null)}>
              {t("common:actions.cancel")}
            </Button>
          </FieldRow>
        ) : null}
        <Table grid columns={columns} data={workers} getRowId={(worker) => worker.id} loading={loading} emptyMessage={t("empty")} />
      </Card>

      <Modal
        isOpen={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={t("editTitle")}
        footer={
          <Button onClick={saveEdit} loading={savingEdit} disabled={!editing?.name.trim()}>
            {t("common:save")}
          </Button>
        }
      >
        <HintText small>{t("editHint", { number: editing?.worker.workerNumber ?? "" })}</HintText>
        <Input label={t("nameLabel")} name="editWorkerName" value={editing?.name ?? ""} onChange={(event) => setEditing((current) => (current ? { ...current, name: event.target.value } : current))} />
        <Input label={t("contractorLabel")} name="editWorkerContractor" value={editing?.contractor ?? ""} onChange={(event) => setEditing((current) => (current ? { ...current, contractor: event.target.value } : current))} />
        {canSetPay && editing ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))", gap: "var(--space-2)" }}>
              <Input label={t("externalPay:rates.amount")} name="editWorkerRate" type="number" value={editing.rate} onChange={(event) => setEditing({ ...editing, rate: event.target.value })} />
              <Select label={t("externalPay:rates.unit")} name="editWorkerRateUnit" value={editing.unit} onChange={(event) => setEditing({ ...editing, unit: event.target.value as RateUnit })}
                options={(["DAILY", "WEEKLY", "MONTHLY", "HOURLY", "YEARLY"] as RateUnit[]).map((u) => ({ value: u, label: t(`externalPay:unit.${u}`) }))} />
              <Input label={t("externalPay:rates.currency")} name="editWorkerRateCurrency" value={editing.currency} onChange={(event) => setEditing({ ...editing, currency: event.target.value.toUpperCase().slice(0, 3) })} />
              <Input label={t("externalPay:rates.effectiveFrom")} name="editWorkerRateFrom" type="date" value={editing.from} onChange={(event) => setEditing({ ...editing, from: event.target.value })} />
            </div>
            <HintText small>{t("externalPay:rates.hint")}</HintText>
          </>
        ) : null}
        <ErrorText>{editError}</ErrorText>
      </Modal>
    </PageShell>
  );
}
