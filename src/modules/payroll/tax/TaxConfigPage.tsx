import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import PageShell from "../../../components/common/PageShell";
import Card from "../../../components/common/Card";
import Button from "../../../components/common/Button";
import Input from "../../../components/common/Input";
import Modal from "../../../components/common/Modal";
import Toggle from "../../../components/common/Toggle";
import StatusBadge from "../../../components/common/StatusBadge";
import ErrorText from "../../../components/common/ErrorText";
import SuccessText from "../../../components/common/SuccessText";
import HintText from "../../../components/common/HintText";
import LoadingState from "../../../components/common/LoadingState";
import humanizeBackendError from "../../../core/utils/humanizeBackendError";
import { formatDateOnly, formatDateTime } from "../../../core/utils/formatDate";
import TaxConfigRepository, { emptyRules, type TaxConfigState, type TaxRules } from "../../../core/repositories/TaxConfigRepository";
import PayrollCycleRepository, { type PayrollComponent } from "../../../core/repositories/PayrollCycleRepository";
import RulesEditor from "./RulesEditor";
import TaxCalculator from "./TaxCalculator";
import { COUNTRY_CODES, countryLabel, countryName, suggestedCurrency } from "./countries";

const monthOf = (iso: string) => iso.slice(0, 7);

// HR suite feature 4: Settings -> Payroll -> Tax and insurance. Egypt is ready (PROSM's values, kept up
// to date) and can be edited with the company taking responsibility; any other country is filled in by
// the company. Every save is a new version from a month; the calculator uses the payroll's own engine.
export default function TaxConfigPage() {
  const { t, i18n } = useTranslation("taxConfig");
  const [s, setS] = useState<TaxConfigState | null>(null);
  const [draft, setDraft] = useState<TaxRules | null>(null);
  const [copied, setCopied] = useState(false);
  const [month, setMonth] = useState("");
  const [ack, setAck] = useState(false);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [countryOpen, setCountryOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await TaxConfigRepository.get();
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("error"));
    setS(r.data);
    setDraft(null);
    setCopied(false);
    setMonth(monthOf(r.data!.nextFreeMonth));
    const c = await PayrollCycleRepository.listComponents();
    setComponents((c.data ?? []).filter((x) => x.is_active && (x.category === "earning" || x.category === "allowance")));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasPack = Boolean(s?.official);
  const current: TaxRules = useMemo(() => {
    const r = s?.rules as TaxRules | undefined;
    return r && "schema" in r ? r : emptyRules();
  }, [s]);
  if (!s) return <PageShell title={t("title")}>{error ? <ErrorText>{error}</ErrorText> : <LoadingState fullHeight />}</PageShell>;

  const editing = draft !== null || !hasPack && s.mode !== "preset";
  const shown = draft ?? current;
  const needsAck = !s.liability.at;

  const save = async (mode: "preset" | "custom") => {
    setBusy(mode);
    setError("");
    setNotice("");
    const r = await TaxConfigRepository.save({ mode, rules: mode === "custom" ? shown : undefined, effectiveFrom: `${month}-01`, acknowledgeLiability: ack, copiedFromPreset: copied });
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("error"));
    setNotice(t("saved", { version: r.data?.version ?? "", date: formatDateOnly(`${month}-01`, i18n.language) }));
    setAck(false);
    await load();
  };

  const setFlag = async (c: PayrollComponent, patch: Partial<PayrollComponent>) => {
    setBusy(c.id);
    const r = await PayrollCycleRepository.saveComponent(c.id, { ...c, ...patch });
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("error"));
    setComponents((all) => all.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
  };

  const badge = s.mode === "preset" ? <StatusBadge status="active">{t("badge.official")}</StatusBadge>
    : hasPack ? <StatusBadge status="pending">{t("badge.modified")}</StatusBadge>
    : <StatusBadge status="invited">{t("badge.manual")}</StatusBadge>;

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}

      <Card title={t("country.title")} actions={s.isOwner ? <Button size="sm" variant="ghost" onClick={() => setCountryOpen(true)}>{t("country.change")}</Button> : undefined}>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: "1.1rem" }}>{countryLabel(s.country, i18n.language)}</strong>
          {badge}
          <span style={{ color: "var(--text-secondary)" }}>{t("country.currency", { currency: s.currency })}{s.version ? ` · ${t("country.version", { version: s.version })}` : ""}</span>
        </div>
        {hasPack && s.officialUpdatedAt ? <HintText small>{t("country.officialUpdated", { date: formatDateOnly(s.officialUpdatedAt, i18n.language) })}{s.officialNote ? ` · ${s.officialNote}` : ""}</HintText> : null}
        {s.mode === "custom" ? <div style={{ marginTop: "var(--space-2)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)" }}>{t("manualNotice")}</div> : null}
        {s.officialChangedSince ? (
          <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <span>{t("officialChanged")}</span>
          </div>
        ) : null}
        {hasPack && s.mode === "custom" ? (
          <div style={{ marginTop: "var(--space-2)" }}>
            <Button size="sm" variant="ghost" loading={busy === "preset"} onClick={() => void save("preset")}>{t("backToOfficial")}</Button>
          </div>
        ) : null}
      </Card>

      {s.missingCategory.length > 0 ? (
        <Card title={t("missing.title", { count: s.missingCategory.length })}>
          <HintText small>{t("missing.hint")}</HintText>
          <p style={{ margin: 0 }}>{s.missingCategory.map((p) => p.name).join("، ")}</p>
        </Card>
      ) : null}

      {hasPack && s.mode === "preset" && draft === null ? (
        <Card>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 16rem" }}>{t("lockedText")}</span>
            <Button size="sm" onClick={() => { setDraft(JSON.parse(JSON.stringify(current)) as TaxRules); setCopied(true); }}>{t("copyAndEdit")}</Button>
          </div>
        </Card>
      ) : null}

      <RulesEditor rules={shown} readOnly={!editing} onChange={(next) => setDraft(next)} />

      <Card title={t("items.title")}>
        <HintText small>{t("items.hint")}</HintText>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={{ textAlign: "start" }}>{t("items.item")}</th><th>{t("items.taxable")}</th><th>{t("items.insurable")}</th></tr></thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                <td>{i18n.language === "ar" ? c.name_ar : c.name_en ?? c.name_ar}</td>
                <td style={{ textAlign: "center" }}><Toggle checked={c.taxable !== false} disabled={busy === c.id} onChange={(on) => void setFlag(c, { taxable: on })} label={t("items.taxable")} /></td>
                <td style={{ textAlign: "center" }}><Toggle checked={Boolean(c.insurable)} disabled={busy === c.id} onChange={(on) => void setFlag(c, { insurable: on })} label={t("items.insurable")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={t("how.title")}>
        <ol style={{ margin: 0, paddingInlineStart: "var(--space-4)", display: "grid", gap: 4 }}>
          <li>{t("how.gross")}</li>
          <li>{t("how.insurance")}</li>
          <li>{t("how.taxBase")}</li>
          <li>{t("how.tax")}</li>
          <li>{t("how.levies")}</li>
          <li>{t("how.net")}</li>
        </ol>
      </Card>

      <TaxCalculator rules={editing ? shown : { preset: s.country }} currency={s.currency} />

      {editing ? (
        <Card title={t("saveTitle")}>
          <HintText small>{t("saveHint")}</HintText>
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ width: "12rem" }}><Input label={t("effectiveFrom")} name="effectiveMonth" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
            {draft ? <Button variant="ghost" style={{ marginBottom: "var(--space-4)" }} onClick={() => { setDraft(null); setCopied(false); }}>{t("cancelEdit")}</Button> : null}
          </div>
          {needsAck ? (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "var(--space-2) 0" }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 4 }} /> <span>{t("liability")}</span>
            </label>
          ) : <HintText small>{t("liabilityDone", { name: s.liability.by ?? "", date: formatDateTime(s.liability.at!, i18n.language) })}</HintText>}
          <Button loading={busy === "custom"} disabled={needsAck && !ack} onClick={() => void save("custom")}>{t("save")}</Button>
        </Card>
      ) : null}

      {s.versions.length > 0 ? (
        <Card title={t("versions.title")}>
          <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)", fontSize: "var(--font-sm)" }}>
            {s.versions.map((v) => (
              <li key={v.id}>{t("versions.row", { version: v.version, country: countryName(v.country, i18n.language), date: formatDateOnly(v.effectiveFrom, i18n.language), by: v.createdBy ?? "" })} · {v.mode === "preset" ? t("badge.official") : t("badge.modified")}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ChangeCountryModal open={countryOpen} state={s} onClose={() => setCountryOpen(false)} onDone={(msg) => { setCountryOpen(false); setNotice(msg); void load(); }} />
    </PageShell>
  );
}

function ChangeCountryModal({ open, state, onClose, onDone }: { open: boolean; state: TaxConfigState; onClose: () => void; onDone: (message: string) => void }) {
  const { t, i18n } = useTranslation("taxConfig");
  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [currency, setCurrency] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useMemo(() => COUNTRY_CODES.map((c) => ({ code: c, label: countryLabel(c, i18n.language) }))
    .sort((a, b) => a.label.slice(5).localeCompare(b.label.slice(5), i18n.language)), [i18n.language]);
  const q = search.trim().toLowerCase();
  const shown = list.filter((c) => c.code !== state.country && (!q || c.label.toLowerCase().includes(q) || c.code.toLowerCase() === q)).slice(0, 60);
  const ready = state.packs.includes(code);

  const go = async () => {
    setBusy(true);
    setError("");
    const r = await TaxConfigRepository.changeCountry(code, confirm, currency, ack);
    setBusy(false);
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("error"));
    onDone(t("country.changed", { country: countryName(code, i18n.language), date: formatDateOnly(r.data!.effectiveFrom, i18n.language) }));
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t("country.change")} size="md"
      footer={code ? <Button fullWidth variant="danger" loading={busy} disabled={confirm.trim().toUpperCase() !== code || (!ready && !state.liability.at && !ack)} onClick={() => void go()}>{t("country.confirmButton")}</Button> : undefined}>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <ErrorText>{error}</ErrorText>
        {state.openCycles > 0 ? <ErrorText>{t("country.openCycle")}</ErrorText> : null}
        {!code ? (
          <>
            <Input label={t("country.search")} name="countrySearch" value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "18rem", overflowY: "auto" }}>
              {shown.map((c) => (
                <li key={c.code}>
                  <button type="button" onClick={() => { setCode(c.code); setCurrency(suggestedCurrency(c.code)); setConfirm(""); }}
                    style={{ width: "100%", textAlign: "start", padding: "8px 4px", border: 0, borderBottom: "1px solid var(--border-light)", background: "none", color: "inherit", font: "inherit", cursor: "pointer" }}>
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <strong>{countryLabel(code, i18n.language)}</strong>
            <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
              <li>{t("country.fromMonth", { date: formatDateOnly(state.nextFreeMonth, i18n.language) })}</li>
              <li>{t("country.oldCyclesKept")}</li>
              <li>{ready ? t("country.readyRules") : t("country.emptyRules")}</li>
              <li>{t("country.categoriesKept")}</li>
            </ul>
            <Input label={t("country.currencyLabel")} name="countryCurrency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            {!ready && !state.liability.at ? (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 4 }} /> <span>{t("liability")}</span>
              </label>
            ) : null}
            <Input label={t("country.typeCode", { code })} name="countryConfirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button size="sm" variant="ghost" onClick={() => setCode("")}>{t("country.chooseAnother")}</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
