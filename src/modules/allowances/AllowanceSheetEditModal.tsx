import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AllowanceRepository, { ALLOWANCE_LINES, LINE_FIELD, type AllowanceEntry, type AllowanceLine, type AllowanceSheet } from "../../core/repositories/AllowanceRepository";
import AllowanceRatesRepository, { type AllowanceBasis, type BasisField } from "../../core/repositories/AllowanceRatesRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";

const lineBasis = (line: AllowanceLine, basis: Record<BasisField, AllowanceBasis> | null): AllowanceBasis =>
  line === "overtime" ? "per_hour" : line === "extraDays" ? "per_extra_day" : basis?.[line] ?? "fixed_per_day";

// v2.3.43 step 5 (item 21): the manager edits the lines of a sheet under
// review - every day, every line: its basis, the computed value, the manager's
// value and a "changed" mark. One reason (required) goes with each saved
// change; the server checks the permission and the site, audits the change,
// and the sheet's total follows at once.
export default function AllowanceSheetEditModal({ sheet, onClose, onChanged }: { sheet: AllowanceSheet | null; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation("allowances");
  const [entries, setEntries] = useState<AllowanceEntry[] | null>(null);
  const [basis, setBasis] = useState<Record<BasisField, AllowanceBasis> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async (sheetId: string) => {
    const result = await AllowanceRepository.listSheetEntries(sheetId);
    setEntries(result.data ?? []);
    if (!result.success) setError(humanizeBackendError(result.message, t) ?? t("reviewError"));
  };

  useEffect(() => {
    if (!sheet) return;
    setEntries(null);
    setDrafts({});
    setReason("");
    setError("");
    void load(sheet.id);
    AllowanceRatesRepository.getBasis().then((result) => setBasis(result.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet?.id]);

  const total = useMemo(
    () => (entries ?? []).reduce((sum, entry) => sum + ALLOWANCE_LINES.reduce((lineSum, line) => lineSum + Number(entry[LINE_FIELD[line]] ?? 0), 0), 0),
    [entries],
  );

  const changes = Object.entries(drafts).filter(([key, value]) => {
    const [entryId, line] = key.split("|") as [string, AllowanceLine];
    const entry = entries?.find((row) => row.id === entryId);
    return entry && value.trim() !== "" && Number(value) !== Number(entry[LINE_FIELD[line]]);
  });

  const handleSave = async () => {
    if (!sheet || changes.length === 0) return;
    if (!reason.trim()) {
      setError(t("sheetEdit.reasonRequired"));
      return;
    }
    if (changes.some(([, value]) => Number.isNaN(Number(value)) || Number(value) < 0)) {
      setError(t("sheetEdit.invalidValue"));
      return;
    }
    setSaving(true);
    setError("");
    for (const [key, value] of changes) {
      const [entryId, line] = key.split("|") as [string, AllowanceLine];
      const result = await AllowanceRepository.adjustEntry(entryId, line, Number(value), reason.trim());
      if (!result.success) {
        setSaving(false);
        setError(humanizeBackendError(result.message, t) ?? t("reviewError"));
        await load(sheet.id);
        return;
      }
    }
    setSaving(false);
    setDrafts({});
    await load(sheet.id);
    onChanged();
  };

  return (
    <Modal
      isOpen={Boolean(sheet)}
      onClose={onClose}
      title={sheet ? t("sheetEdit.title", { name: sheet.userFullName }) : ""}
      footer={
        <Button onClick={handleSave} loading={saving} disabled={changes.length === 0}>
          {t("sheetEdit.save", { count: changes.length })}
        </Button>
      }
    >
      <HintText small>{t("sheetEdit.hint")}</HintText>
      {!entries ? (
        <LoadingState />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)", maxHeight: "55vh", overflowY: "auto" }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
              <div style={{ fontWeight: "var(--font-weight-semibold)", fontSize: "var(--font-sm)", marginBottom: "var(--space-2)" }}>
                {formatDateOnly(entry.entryDate, i18n.language)} {entry.siteName ? `· ${entry.siteName}` : ""}
              </div>
              <div style={{ display: "grid", gap: "var(--space-2)", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))" }}>
                {ALLOWANCE_LINES.map((line) => {
                  const current = Number(entry[LINE_FIELD[line]] ?? 0);
                  const override = entry.manualOverrides[line];
                  const key = `${entry.id}|${line}`;
                  return (
                    <label key={line} style={{ display: "grid", gap: 2, fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                      <span>
                        {t(`sheetEdit.line.${line}`)} · {t(`basis.option.${lineBasis(line, basis)}`)}
                        {override ? <strong style={{ color: "var(--status-warning-text, var(--text-primary))" }}> · {t("sheetEdit.changed")}</strong> : null}
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        value={drafts[key] ?? String(current)}
                        onChange={(event) => setDrafts((all) => ({ ...all, [key]: event.target.value }))}
                        disabled={saving}
                        style={{ minHeight: 36, padding: "0 var(--space-2)", border: "1px solid var(--border-medium)", borderRadius: "var(--radius-sm)", background: "var(--surface-raised)", color: "var(--text-primary)", font: "inherit", fontSize: "var(--font-sm)" }}
                      />
                      {override ? <span>{t("sheetEdit.computed", { value: override.original.toLocaleString(i18n.language) })}</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: "var(--space-3) 0", fontWeight: "var(--font-weight-semibold)" }}>{t("sheetEdit.total", { total: total.toLocaleString(i18n.language, { maximumFractionDigits: 2 }) })}</p>
      <Textarea label={t("sheetEdit.reasonLabel")} name="sheetEditReason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving} />
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
