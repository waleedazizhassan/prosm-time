import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { money, parseAmount, payrollError } from "./payrollUi";
import SalaryItemsSection from "./SalaryItemsSection";
import { legalNameProblem, nameMustBeArabic } from "./payrollUi";
import usePayrollDigits from "./usePayrollDigits";
import TaxConfigRepository from "../../core/repositories/TaxConfigRepository";
import SuccessText from "../../components/common/SuccessText";

const today = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

// 2026-11-08: payroll profiles - each person's code, currency, start/end dates and fixed
// components with effective dates (a new value never rewrites an earlier cycle) - and the
// installment / advance plans.
// HR suite feature 3 (2026-11-11): the same salary file also opens inside the employee profile's
// "Pay" tab (embedUserId) - the same editor and the same save, without the list around it.
export default function PayrollProfilesPage({ embedUserId }: { embedUserId?: string } = {}) {
  const { t, i18n } = useTranslation("payroll");
  const navigate = useNavigate();
  const isRtl = i18n.dir() === "rtl";
  usePayrollDigits();
  const [people, setPeople] = useState<PayrollPerson[] | null>(null);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<PayrollPerson | null>(null);
  // Owner 2026-11-10: the official name (in the language of the payroll's country - Arabic for an Arab
  // country) is required on the card and is the name on the payslip; the user's own name may be a nickname.
  const [nameInArabic, setNameInArabic] = useState(true);
  useEffect(() => {
    void PayrollCycleRepository.getStatutory().then((r) => setNameInArabic(nameMustBeArabic(r.data?.countryCode)));
  }, []);
  const [form, setForm] = useState({ legal_name: "", employee_code: "", currency: "", start_date: "", end_date: "", is_active: true, notes: "", insurance_exempt: false, insurable_wage: "", tax_exempt: false, insurance_category: "" });
  // 2026-11-11 HR suite feature 4: the insurance categories in force (citizen / non-citizen...)
  const [categories, setCategories] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    void TaxConfigRepository.categories().then((r) => setCategories(r.data ?? []));
  }, []);
  const [values, setValues] = useState<Record<string, { amount: string; percent: string; from: string }>>({});
  const [initial, setInitial] = useState<Record<string, { amount: string; percent: string }>>({});
  const [valuesFrom, setValuesFrom] = useState(firstOfMonth());
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  // Owner 2026-11-10: say plainly that it was saved (on the page too, after the window closes)
  const [notice, setNotice] = useState("");
  const [addingItem, setAddingItem] = useState("");
  const [plan, setPlan] = useState({ userId: "", name: "", total: "", count: "", start: today(), installment: "" });
  const [change, setChange] = useState<{ plan: InstallmentPlan; action: "settle" | "cancel" | "reschedule"; reason: string; installment: string } | null>(null);
  const [changeError, setChangeError] = useState("");

  const fixed = useMemo(() => components.filter((c) => c.is_active && c.source === "fixed"), [components]);
  // Owner 2026-11-10 ("an item I add on one employee's card shows on everyone's, and deleting it from one
  // deletes it from all"): a card shows the basic salary and that person's own items only - an item added
  // here is this person's, and deleting it ends it for this person alone.
  const [addedHere, setAddedHere] = useState<string[]>([]);
  const ownIds = useMemo(() => new Set([...(editing?.components ?? []).map((v) => v.componentId), ...addedHere]), [editing, addedHere]);
  const shown = useMemo(() => fixed.filter((c) => c.is_basic || ownIds.has(c.id)), [fixed, ownIds]);
  // Owner 2026-11-10: the salary card shows earnings and deductions together - basic first.
  const earningItems = useMemo(() => shown.filter((c) => c.category === "earning" || c.category === "allowance").sort((a, b) => Number(b.is_basic) - Number(a.is_basic) || a.sort_order - b.sort_order), [shown]);
  const deductionItems = useMemo(() => shown.filter((c) => c.category === "deduction").sort((a, b) => a.sort_order - b.sort_order), [shown]);
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
    setAddedHere([]);
    setSaveError("");
    setSaved(false);
    setValuesFrom(firstOfMonth());
    setForm({
      legal_name: person.profile?.legal_name ?? "", employee_code: person.profile?.employee_code ?? "", currency: person.profile?.currency ?? "", start_date: person.profile?.start_date ?? "",
      end_date: person.profile?.end_date ?? "", is_active: person.profile?.is_active ?? true, notes: person.profile?.notes ?? "",
      insurance_exempt: Boolean(person.profile?.insurance_exempt), insurable_wage: person.profile?.insurable_wage != null ? String(person.profile.insurable_wage) : "",
      insurance_category: person.profile?.insurance_category ?? "",
      tax_exempt: Boolean(person.profile?.tax_exempt),
    });
    setValues(Object.fromEntries(fixed.map((c) => {
      const current = person.components.filter((v) => v.componentId === c.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return [c.id, { amount: current?.amount != null ? String(current.amount) : "", percent: current?.percent != null ? String(current.percent) : c.percent != null ? String(c.percent) : "", from: today() }];
    })));
    setInitial(Object.fromEntries(fixed.map((c) => {
      const current = person.components.filter((v) => v.componentId === c.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return [c.id, { amount: current?.amount != null ? String(current.amount) : "", percent: current?.percent != null ? String(current.percent) : "" }];
    })));
  };

  // One save for everything: the file first (it is created if missing), then every item whose value changed,
  // from the chosen date. Stops at the first refusal and says which item.
  const saveAll = async () => {
    if (!editing) return;
    setSaveError("");
    setSaved(false);
    const legalName = form.legal_name.trim().replace(/\s+/g, " ");
    const nameProblem = legalNameProblem(legalName, nameInArabic);
    if (nameProblem) {
      setSaveError(t(`errors.${nameProblem}`));
      return;
    }
    const insurable = parseAmount(form.insurable_wage);
    if (Number.isNaN(insurable)) {
      setSaveError(t("profiles.badNumber", { field: t("profiles.insurableWage") }));
      return;
    }
    const changes: { id: string; name: string; amount: number | null; percent: number | null }[] = [];
    for (const c of fixed) {
      const now = values[c.id] ?? { amount: "", percent: "" };
      const before = initial[c.id] ?? { amount: "", percent: "" };
      const raw = c.calc_type === "percent" ? now.percent : now.amount;
      const was = c.calc_type === "percent" ? before.percent : before.amount;
      const parsed = parseAmount(raw);
      if (raw.trim() === was.trim() || (parsed !== null && !Number.isNaN(parsed) && parsed === parseAmount(was))) continue;
      if (Number.isNaN(parsed)) {
        setSaveError(t("profiles.badNumber", { field: label(c) }));
        return;
      }
      // emptied: the item ends the day before the chosen date (its history stays)
      changes.push({ id: c.id, name: label(c), amount: c.calc_type === "amount" ? parsed : null, percent: c.calc_type === "percent" ? parsed : null });
    }
    setBusy("save-all");
    const profile = await PayrollCycleRepository.saveProfile(editing.userId, {
      legal_name: legalName, employee_code: form.employee_code, currency: form.currency.toUpperCase() || null, start_date: form.start_date || null, end_date: form.end_date || null,
      is_active: form.is_active, notes: form.notes, insurance_exempt: form.insurance_exempt, insurable_wage: insurable, tax_exempt: form.tax_exempt,
      ...(categories.length > 1 ? { insurance_category: form.insurance_category || null } : {}),
    });
    if (profile.error) {
      setBusy("");
      setSaveError(payrollError(profile.error, t));
      return;
    }
    for (const change of changes) {
      const result = await PayrollCycleRepository.setProfileComponent(editing.userId, change.id, change.amount, change.percent, valuesFrom || today());
      if (result.error) {
        setBusy("");
        setSaveError(`${change.name}: ${payrollError(result.error, t)}`);
        await load();
        return;
      }
    }
    setBusy("");
    setSaved(true);
    await load();
    setInitial(Object.fromEntries(fixed.map((c) => [c.id, { amount: values[c.id]?.amount ?? "", percent: values[c.id]?.percent ?? "" }])));
    setNotice(changes.length > 0 ? t("profiles.savedNotice", { name: editing.fullName, count: changes.length }) : t("profiles.savedNoticeFile", { name: editing.fullName }));
    if (!embedUserId) window.setTimeout(() => setEditing(null), 900);
  };

  // Owner 2026-11-10: delete an item from THIS person's card - it ends for them from the chosen date (their
  // open cycles follow; approved ones keep their copy); other people's cards are not touched.
  const deleteItem = async (component: PayrollComponent) => {
    if (!editing) return false;
    setSaveError("");
    const hasValue = editing.components.some((v) => v.componentId === component.id);
    if (hasValue) {
      const result = await PayrollCycleRepository.setProfileComponent(editing.userId, component.id, null, null, valuesFrom || firstOfMonth());
      if (result.error) {
        setSaveError(payrollError(result.error, t));
        return false;
      }
    }
    setAddedHere((ids) => ids.filter((id) => id !== component.id));
    setValues((all) => ({ ...all, [component.id]: { amount: "", percent: "", from: valuesFrom } }));
    setInitial((all) => ({ ...all, [component.id]: { amount: "", percent: "" } }));
    if (hasValue) await load();
    setNotice(t("profiles.itemDeleted", { name: label(component) }));
    return true;
  };

  // A new fixed item created from the card itself, already on the right side (earning or deduction).
  const addItem = async (kind: "earnings" | "deductions", name: string, amount: string) => {
    const parsed = parseAmount(amount);
    if (Number.isNaN(parsed)) {
      setSaveError(t("profiles.badNumber", { field: name }));
      return false;
    }
    setAddingItem(kind);
    setSaveError("");
    // an item of the same name and side that already exists is used again (no duplicate in the list)
    const category = kind === "earnings" ? "earning" : "deduction";
    const wanted = name.trim().toLowerCase();
    const existing = fixed.find((c) => !c.is_basic && c.calc_type === "amount" && (c.category === category || (category === "earning" && c.category === "allowance"))
      && [c.name_ar, c.name_en ?? ""].some((n) => n.trim().toLowerCase() === wanted));
    let id = existing?.id ?? "";
    if (!id) {
      const result = await PayrollCycleRepository.saveComponent(null, {
        name_ar: name, name_en: name, category, source: "fixed", calc_type: "amount", include_in_net: true,
      });
      if (result.error || !result.data?.id) {
        setAddingItem("");
        setSaveError(payrollError(result.error, t));
        return false;
      }
      id = result.data.id;
      const comps = await PayrollCycleRepository.listComponents();
      setComponents(comps.data ?? []);
    }
    setAddingItem("");
    setAddedHere((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setValues((all) => ({ ...all, [id]: { amount: parsed === null ? "" : String(parsed), percent: "", from: valuesFrom } }));
    setInitial((all) => ({ ...all, [id]: { amount: "", percent: "" } }));
    return true;
  };

  const act = async (key: string, task: () => Promise<{ error: string | null }>) => {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await task();
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else setNotice(t("profiles.savedShort"));
    await load();
    return !result.error;
  };

  const embedOpenedRef = useRef(false);
  useEffect(() => {
    if (!embedUserId || embedOpenedRef.current || !people || components.length === 0) return;
    const person = people.find((p) => p.userId === embedUserId);
    if (!person) return;
    embedOpenedRef.current = true;
    openPerson(person);
    // openPerson only reads the loaded lists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedUserId, people, components]);

  const columns: TableColumn<PayrollPerson>[] = [
    { key: "name", header: t("profiles.person"), render: (p) => (
      <span style={{ display: "grid" }}>
        <strong>{p.profile?.legal_name || p.fullName}</strong>
        {p.profile?.legal_name && p.profile.legal_name !== p.fullName ? <small style={{ color: "var(--text-secondary)" }}>{p.fullName}</small> : null}
        {!p.profile?.legal_name ? <small style={{ color: "var(--status-warning-text)" }}>{t("profiles.legalNameMissing")}</small> : null}
      </span>
    ) },
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

  const editorBody = (
    <>
{editing ? (
          <>
            {saveError ? <div ref={(el) => el?.scrollIntoView({ block: "nearest" })}><ErrorText>{saveError}</ErrorText></div> : null}
            {saved ? <SuccessText>{t("profiles.savedAll")}</SuccessText> : null}

            <Input label={nameInArabic ? t("profiles.legalNameArabicLabel") : t("profiles.legalNameLabel")} name="profileLegalName" required
              value={form.legal_name} onChange={(event) => setForm({ ...form, legal_name: event.target.value })}
              helperText={t("profiles.legalNameHint", { user: editing.fullName })}
              error={form.legal_name.trim() && legalNameProblem(form.legal_name.trim(), nameInArabic) ? t(`errors.${legalNameProblem(form.legal_name.trim(), nameInArabic)}`) : undefined} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-2)" }}>
              <Input label={t("doc.code")} name="profileCode" value={form.employee_code} onChange={(event) => setForm({ ...form, employee_code: event.target.value })} />
              <Input label={t("profiles.applyFromDate")} name="valuesFrom" type="date" value={valuesFrom} onChange={(event) => setValuesFrom(event.target.value)}
                helperText={t("profiles.applyFromHint")} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(19rem, 100%), 1fr))", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
              <SalaryItemsSection kind="earnings" items={earningItems} values={values} label={label} adding={addingItem === "earnings"}
                onChange={(id, value) => setValues((all) => ({ ...all, [id]: value }))} onAdd={(name, amount) => addItem("earnings", name, amount)} onDelete={deleteItem} />
              <SalaryItemsSection kind="deductions" items={deductionItems} values={values} label={label} adding={addingItem === "deductions"}
                onChange={(id, value) => setValues((all) => ({ ...all, [id]: value }))} onAdd={(name, amount) => addItem("deductions", name, amount)} onDelete={deleteItem} />
            </div>
            {(() => {
              const sum = (list: PayrollComponent[]) => list.reduce((s, c) => {
                if (c.calc_type === "percent") return s;
                const v = parseAmount(values[c.id]?.amount ?? "");
                return s + (v && !Number.isNaN(v) ? v : 0);
              }, 0);
              return (
                <p style={{ display: "flex", justifyContent: "space-between", margin: "var(--space-3) 0 0", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--brand-gradient-soft, transparent), var(--surface-sunken)", fontWeight: 700 }}>
                  <span>{t("profiles.netBeforeStatutory")}</span>
                  <span>{money(sum(earningItems) - sum(deductionItems))} {form.currency || editing.profile?.currency || ""}</span>
                </p>
              );
            })()}
            <HintText small>{t("profiles.salaryHint")}</HintText>

            <h4 style={{ margin: "var(--space-3) 0 var(--space-1)" }}>{t("profiles.statutoryTitle")}</h4>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" }}>
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <input type="checkbox" checked={form.insurance_exempt} onChange={(event) => setForm({ ...form, insurance_exempt: event.target.checked })} /> {t("profiles.insuranceExempt")}
              </label>
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <input type="checkbox" checked={form.tax_exempt} onChange={(event) => setForm({ ...form, tax_exempt: event.target.checked })} /> {t("profiles.taxExempt")}
              </label>
              {!form.insurance_exempt && categories.length > 1 ? (
                <div style={{ maxWidth: 240 }}>
                  <Select label={t("profiles.insuranceCategory")} name="insuranceCategory" value={form.insurance_category} onChange={(event) => setForm({ ...form, insurance_category: event.target.value })}
                    options={[{ value: "", label: t("profiles.insuranceCategoryDefault") }, ...categories.map((c) => ({ value: c.code, label: c.name }))]} />
                </div>
              ) : null}
              {!form.insurance_exempt ? (
                <div style={{ maxWidth: 240 }}>
                  <Input label={t("profiles.insurableWage")} name="insurableWage" inputMode="decimal" value={form.insurable_wage} onChange={(event) => setForm({ ...form, insurable_wage: event.target.value })} />
                </div>
              ) : null}
            </div>
            <HintText small>{t("profiles.statutoryHint")}</HintText>

            <details style={{ marginTop: "var(--space-3)" }}>
              <summary style={{ cursor: "pointer", fontSize: "var(--font-sm)", color: "var(--text-link)" }}>{t("profiles.moreOptions")}</summary>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Input label={t("doc.currency")} name="profileCurrency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase().slice(0, 3) })} />
                <Input label={t("profiles.startDate")} name="profileStart" type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
                <Input label={t("profiles.endDate")} name="profileEnd" type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
              </div>
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", margin: "var(--space-2) 0" }}>
                <input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} /> {t("profiles.active")}
              </label>
              <Textarea label={t("profiles.notes")} name="profileNotes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={2} />
              <HintText small>{t("profiles.historyHint")}</HintText>
            </details>
          </>
        ) : null}
    </>
  );

  if (embedUserId) {
    return (
      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {people !== null && !people.some((p) => p.userId === embedUserId) ? <HintText>{t("profiles.notInPayroll")}</HintText> : null}
        {editorBody}
        {editing ? <Button fullWidth loading={busy === "save-all"} onClick={() => void saveAll()}>{t("profiles.saveAll")}</Button> : null}
      </div>
    );
  }

  return (
    <PageShell title={t("nav.profiles")} subtitle={t("profiles.hint")} wide>
      <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      <Card title={t("profiles.title")}>
        <div style={{ maxWidth: 360, marginBottom: "var(--space-2)" }}>
          <Input label={t("profiles.search")} name="profilesSearch" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <HintText small>{t("profiles.tapToEdit")}</HintText>
        <Table columns={columns} data={(people ?? []).filter((p) => !search.trim() || p.fullName.toLowerCase().includes(search.trim().toLowerCase()) || (p.profile?.legal_name ?? "").includes(search.trim()) || (p.profile?.employee_code ?? "").includes(search.trim()))}
          getRowId={(p) => p.userId} loading={people === null} emptyMessage={t("profiles.empty")} onRowClick={openPerson} />
      </Card>

      <Card title={t("installments.title")} subtitle={t("installments.hint")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)" }}>
          <Select label={t("profiles.person")} name="planUser" value={plan.userId} onChange={(event) => setPlan({ ...plan, userId: event.target.value })}
            options={[{ value: "", label: "-" }, ...(people ?? []).filter((p) => p.profile).map((p) => ({ value: p.userId, label: p.fullName }))]} />
          <Input label={t("installments.name")} name="planName" value={plan.name} onChange={(event) => setPlan({ ...plan, name: event.target.value })} />
          <Input label={t("installments.total")} name="planTotal" inputMode="decimal" value={plan.total} onChange={(event) => setPlan({ ...plan, total: event.target.value })} />
          <Input label={t("installments.count")} name="planCount" inputMode="numeric" value={plan.count} onChange={(event) => setPlan({ ...plan, count: event.target.value })} />
          <Input label={t("installments.start")} name="planStart" type="date" value={plan.start} onChange={(event) => setPlan({ ...plan, start: event.target.value })} />
          <Input label={t("installments.amountOptional")} name="planAmount" inputMode="decimal" value={plan.installment} onChange={(event) => setPlan({ ...plan, installment: event.target.value })} />
        </div>
        <Button size="sm" loading={busy === "plan"} disabled={!plan.userId || !plan.name.trim() || !plan.total || !plan.count}
          onClick={async () => {
            const ok = await act("plan", () => PayrollCycleRepository.saveInstallment(plan.userId, plan.name.trim(), parseAmount(plan.total) ?? 0, parseAmount(plan.count) ?? 0, plan.start, parseAmount(plan.installment)));
            if (ok) setPlan({ userId: "", name: "", total: "", count: "", start: today(), installment: "" });
          }}>{t("installments.add")}</Button>
        <Table columns={planColumns} data={plans} getRowId={(p) => p.id} emptyMessage={t("installments.empty")} />
      </Card>

      {/* Owner 2026-11-09 ("payroll must be simpler; the fields don't save"): one screen per person - the
          salary items with one start date, insurance and tax, and ONE save that keeps everything.
          Errors show inside the window. Amounts accept Arabic digits. */}
      <Modal isOpen={Boolean(editing) && !embedUserId} onClose={() => setEditing(null)} title={editing ? t("profiles.editorTitle", { name: editing.fullName }) : ""} size="lg"
        footer={<Button fullWidth loading={busy === "save-all"} onClick={() => void saveAll()}>{t("profiles.saveAll")}</Button>}>
        {embedUserId ? null : editorBody}
      </Modal>

      <Modal isOpen={Boolean(change)} onClose={() => setChange(null)} title={change ? t(`installments.${change.action}`) : ""}
        footer={<Button variant={change?.action === "cancel" ? "danger" : "primary"} loading={busy === "change"} onClick={async () => {
          if (!change) return;
          if (!change.reason.trim()) { setChangeError(t("errors.reasonRequired")); return; }
          setChangeError("");
          const result = await PayrollCycleRepository.changeInstallment(change.plan.id, change.action, change.reason.trim(), parseAmount(change.installment), null, change.plan.row_version);
          if (result.error) { setChangeError(payrollError(result.error, t)); return; }
          setChange(null);
          setNotice(t("profiles.savedShort"));
          await load();
        }}>{change ? t(`installments.${change.action}`) : ""}</Button>}>
        {changeError ? <ErrorText>{changeError}</ErrorText> : null}
        {change?.action === "reschedule" ? <Input label={t("installments.amount")} name="newInstallment" inputMode="decimal" value={change.installment} onChange={(event) => setChange({ ...change, installment: event.target.value })} /> : null}
        {change ? <Textarea label={t("actions.reason")} name="planReason" value={change.reason} onChange={(event) => setChange({ ...change, reason: event.target.value })} /> : null}
      </Modal>
    </PageShell>
  );
}
