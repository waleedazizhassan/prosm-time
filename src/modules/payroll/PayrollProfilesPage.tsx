import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PayrollCycleRepository, { type InstallmentPlan, type PayrollComponent, type PayrollPerson } from "../../core/repositories/PayrollCycleRepository";
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
import { money, payrollError } from "./payrollUi";

const today = () => new Date().toISOString().slice(0, 10);

// 2026-11-08: payroll profiles - each person's code, currency, start/end dates and fixed
// components with effective dates (a new value never rewrites an earlier cycle) - and the
// installment / advance plans.
export default function PayrollProfilesPage() {
  const { t, i18n } = useTranslation("payroll");
  const navigate = useNavigate();
  const isRtl = i18n.dir() === "rtl";
  const [people, setPeople] = useState<PayrollPerson[] | null>(null);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<PayrollPerson | null>(null);
  const [form, setForm] = useState({ employee_code: "", currency: "", start_date: "", end_date: "", is_active: true, notes: "" });
  const [values, setValues] = useState<Record<string, { amount: string; percent: string; from: string }>>({});
  const [plan, setPlan] = useState({ userId: "", name: "", total: "", count: "", start: today(), installment: "" });
  const [change, setChange] = useState<{ plan: InstallmentPlan; action: "settle" | "cancel" | "reschedule"; reason: string; installment: string } | null>(null);

  const fixed = useMemo(() => components.filter((c) => c.is_active && c.source === "fixed"), [components]);
  const label = (c: { name_ar: string; name_en: string | null }) => (isRtl ? c.name_ar : c.name_en || c.name_ar);

  const load = useCallback(async () => {
    const [list, comps, plansResult] = await Promise.all([PayrollCycleRepository.listProfiles(), PayrollCycleRepository.listComponents(), PayrollCycleRepository.listInstallments()]);
    if (list.error) setError(payrollError(list.error, t));
    setPeople(list.data ?? []);
    setComponents(comps.data ?? []);
    setPlans(plansResult.data ?? []);
    setEditing((current) => (current && list.data ? list.data.find((p) => p.userId === current.userId) ?? null : current));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPerson = (person: PayrollPerson) => {
    setEditing(person);
    setForm({
      employee_code: person.profile?.employee_code ?? "", currency: person.profile?.currency ?? "", start_date: person.profile?.start_date ?? "",
      end_date: person.profile?.end_date ?? "", is_active: person.profile?.is_active ?? true, notes: person.profile?.notes ?? "",
    });
    setValues(Object.fromEntries(fixed.map((c) => {
      const current = person.components.filter((v) => v.componentId === c.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return [c.id, { amount: current?.amount != null ? String(current.amount) : "", percent: current?.percent != null ? String(current.percent) : c.percent != null ? String(c.percent) : "", from: today() }];
    })));
  };

  const act = async (key: string, task: () => Promise<{ error: string | null }>) => {
    setBusy(key);
    setError("");
    const result = await task();
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    await load();
    return !result.error;
  };

  const columns: TableColumn<PayrollPerson>[] = [
    { key: "name", header: t("profiles.person"), render: (p) => <strong>{p.fullName}</strong> },
    { key: "site", header: t("doc.site"), render: (p) => p.siteName ?? "-" },
    { key: "code", header: t("doc.code"), render: (p) => p.profile?.employee_code ?? "-" },
    { key: "basic", header: t("doc.basic"), render: (p) => {
      const basic = p.components.find((v) => fixed.find((c) => c.id === v.componentId)?.is_basic && (!v.effectiveTo || v.effectiveTo >= today()));
      return basic?.amount != null ? `${money(basic.amount)} ${p.profile?.currency ?? ""}` : "-";
    } },
    { key: "state", header: "", render: (p) => (p.profile ? <StatusBadge status={p.profile.is_active ? "active" : "inactive"}>{p.profile.is_active ? t("profiles.active") : t("profiles.inactive")}</StatusBadge> : <StatusBadge status="neutral">{t("profiles.none")}</StatusBadge>) },
  ];

  const planColumns: TableColumn<InstallmentPlan>[] = [
    { key: "who", header: t("profiles.person"), render: (p) => p.fullName },
    { key: "name", header: t("installments.name"), render: (p) => p.name },
    { key: "progress", header: t("installments.progress"), render: (p) => t("installments.paidOf", { paid: p.paidCount, count: p.installments_count }) },
    { key: "remaining", header: t("installments.remaining"), render: (p) => `${money(p.remaining)} ${p.currency}` },
    { key: "status", header: "", render: (p) => <StatusBadge status={p.status === "active" ? "active" : "neutral"}>{t(`installments.status.${p.status}`)}</StatusBadge> },
    { key: "actions", header: "", render: (p) => (p.status === "active" ? (
      <div style={{ display: "flex", gap: 4 }}>
        <Button size="xs" variant="ghost" onClick={() => setChange({ plan: p, action: "reschedule", reason: "", installment: String(p.installment_amount) })}>{t("installments.reschedule")}</Button>
        <Button size="xs" variant="ghost" onClick={() => setChange({ plan: p, action: "settle", reason: "", installment: "" })}>{t("installments.settle")}</Button>
        <Button size="xs" variant="danger" onClick={() => setChange({ plan: p, action: "cancel", reason: "", installment: "" })}>{t("installments.cancel")}</Button>
      </div>) : null) },
  ];

  return (
    <PageShell title={t("nav.profiles")} subtitle={t("profiles.hint")} wide>
      <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
      <ErrorText>{error}</ErrorText>
      {fixed.length === 0 ? <HintText>{t("profiles.noFixedComponents")}</HintText> : null}
      <Card title={t("profiles.title")}>
        <Table columns={columns} data={people ?? []} getRowId={(p) => p.userId} loading={people === null} emptyMessage={t("profiles.empty")} onRowClick={openPerson} />
      </Card>

      <Card title={t("installments.title")} subtitle={t("installments.hint")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)" }}>
          <Select label={t("profiles.person")} name="planUser" value={plan.userId} onChange={(event) => setPlan({ ...plan, userId: event.target.value })}
            options={[{ value: "", label: "-" }, ...(people ?? []).filter((p) => p.profile).map((p) => ({ value: p.userId, label: p.fullName }))]} />
          <Input label={t("installments.name")} name="planName" value={plan.name} onChange={(event) => setPlan({ ...plan, name: event.target.value })} />
          <Input label={t("installments.total")} name="planTotal" type="number" value={plan.total} onChange={(event) => setPlan({ ...plan, total: event.target.value })} />
          <Input label={t("installments.count")} name="planCount" type="number" value={plan.count} onChange={(event) => setPlan({ ...plan, count: event.target.value })} />
          <Input label={t("installments.start")} name="planStart" type="date" value={plan.start} onChange={(event) => setPlan({ ...plan, start: event.target.value })} />
          <Input label={t("installments.amountOptional")} name="planAmount" type="number" value={plan.installment} onChange={(event) => setPlan({ ...plan, installment: event.target.value })} />
        </div>
        <Button size="sm" loading={busy === "plan"} disabled={!plan.userId || !plan.name.trim() || !plan.total || !plan.count}
          onClick={async () => {
            const ok = await act("plan", () => PayrollCycleRepository.saveInstallment(plan.userId, plan.name.trim(), Number(plan.total), Number(plan.count), plan.start, plan.installment ? Number(plan.installment) : null));
            if (ok) setPlan({ userId: "", name: "", total: "", count: "", start: today(), installment: "" });
          }}>{t("installments.add")}</Button>
        <Table columns={planColumns} data={plans} getRowId={(p) => p.id} emptyMessage={t("installments.empty")} />
      </Card>

      <Modal isOpen={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.fullName ?? ""} size="lg"
        footer={<Button loading={busy === "profile"} onClick={() => editing && act("profile", () => PayrollCycleRepository.saveProfile(editing.userId, {
          employee_code: form.employee_code, currency: form.currency.toUpperCase() || null, start_date: form.start_date || null, end_date: form.end_date || null, is_active: form.is_active, notes: form.notes,
        }))}>{t("profiles.saveProfile")}</Button>}>
        {editing ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)" }}>
              <Input label={t("doc.code")} name="profileCode" value={form.employee_code} onChange={(event) => setForm({ ...form, employee_code: event.target.value })} />
              <Input label={t("doc.currency")} name="profileCurrency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase().slice(0, 3) })} />
              <Input label={t("profiles.startDate")} name="profileStart" type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
              <Input label={t("profiles.endDate")} name="profileEnd" type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
            </div>
            <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", margin: "var(--space-2) 0" }}>
              <input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} /> {t("profiles.active")}
            </label>
            <Textarea label={t("profiles.notes")} name="profileNotes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={2} />

            <h4>{t("profiles.fixedTitle")}</h4>
            {!editing.profile ? <HintText small>{t("errors.profileFirst")}</HintText> : fixed.map((c) => {
              const value = values[c.id] ?? { amount: "", percent: "", from: today() };
              return (
                <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end", borderBottom: "1px solid var(--border-light)", paddingBottom: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                  <div style={{ flex: "1 1 10rem" }}><strong>{label(c)}</strong><HintText small>{t(`categories.${c.category}`)}{c.include_in_net ? "" : ` · ${t("lines.outsideNet")}`}</HintText></div>
                  {c.calc_type === "amount"
                    ? <Input label={t("lines.amount")} name={`amount-${c.id}`} type="number" value={value.amount} onChange={(event) => setValues({ ...values, [c.id]: { ...value, amount: event.target.value } })} />
                    : <Input label={t("components.percent")} name={`percent-${c.id}`} type="number" value={value.percent} onChange={(event) => setValues({ ...values, [c.id]: { ...value, percent: event.target.value } })} />}
                  <Input label={t("profiles.effectiveFrom")} name={`from-${c.id}`} type="date" value={value.from} onChange={(event) => setValues({ ...values, [c.id]: { ...value, from: event.target.value } })} />
                  <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => act(c.id, () => PayrollCycleRepository.setProfileComponent(editing.userId, c.id,
                    c.calc_type === "amount" ? (value.amount === "" ? null : Number(value.amount)) : null, c.calc_type === "percent" ? (value.percent === "" ? null : Number(value.percent)) : null, value.from))}>
                    {t("profiles.applyFrom")}
                  </Button>
                </div>
              );
            })}
            <HintText small>{t("profiles.historyHint")}</HintText>
          </>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(change)} onClose={() => setChange(null)} title={change ? t(`installments.${change.action}`) : ""}
        footer={<Button variant={change?.action === "cancel" ? "danger" : "primary"} loading={busy === "change"} onClick={async () => {
          if (!change) return;
          if (!change.reason.trim()) { setError(t("errors.reasonRequired")); return; }
          const ok = await act("change", () => PayrollCycleRepository.changeInstallment(change.plan.id, change.action, change.reason.trim(), change.installment ? Number(change.installment) : null, null, change.plan.row_version));
          if (ok) setChange(null);
        }}>{change ? t(`installments.${change.action}`) : ""}</Button>}>
        {change?.action === "reschedule" ? <Input label={t("installments.amount")} name="newInstallment" type="number" value={change.installment} onChange={(event) => setChange({ ...change, installment: event.target.value })} /> : null}
        {change ? <Textarea label={t("actions.reason")} name="planReason" value={change.reason} onChange={(event) => setChange({ ...change, reason: event.target.value })} /> : null}
      </Modal>
    </PageShell>
  );
}
