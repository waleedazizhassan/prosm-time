import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AllowanceEntry, AllowanceEntryInput } from "../../core/repositories/AllowanceRepository";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import styles from "./AllowanceSheetGrid.module.css";

type Field = "mealAllowance" | "expatriationAllowance" | "transportationAllowance" | "housingAllowance" | "travelAllowance" | "otherAllowance";

const MONEY_COLUMNS: { field: Field; label: string }[] = [
  { field: "expatriationAllowance", label: "expatriation" },
  { field: "transportationAllowance", label: "transportation" },
  { field: "travelAllowance", label: "travel" },
  { field: "mealAllowance", label: "meal" },
  { field: "housingAllowance", label: "housing" },
  { field: "otherAllowance", label: "other" },
];

// the same badges as the rest of the allowances page
const STATUS_BADGE: Record<AllowanceEntry["status"], string> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "revoked",
};

export function entryInput(entry: AllowanceEntry): AllowanceEntryInput {
  return {
    mealAllowance: entry.mealAllowance,
    expatriationAllowance: entry.expatriationAllowance,
    transportationAllowance: entry.transportationAllowance,
    housingAllowance: entry.housingAllowance,
    travelAllowance: entry.travelAllowance,
    otherAllowance: entry.otherAllowance,
    otherAllowanceNote: entry.otherAllowanceNote,
  };
}

const total = (entry: AllowanceEntry) =>
  entry.mealAllowance + entry.expatriationAllowance + entry.transportationAllowance + entry.housingAllowance + entry.travelAllowance + entry.otherAllowance + entry.overtimeAmount + entry.extraDaysAmount;

// v2.3.46 (owner 2026-10-26: "like the Excel sheet - when I open my
// allowances, the table that gets printed, and I edit in it"): the
// allowances as one sheet - a row per day, the columns side by side, the
// totals at the foot - that scrolls sideways on a phone with the day kept in
// view, instead of one long card per day. Your own days that are not yet
// approved are edited right in their cells (saved when you leave the cell);
// the day opens its full detail (review, notes) as before.
export default function AllowanceSheetGrid({
  entries,
  ownUserId,
  loading,
  emptyMessage,
  onOpen,
  onSave,
}: {
  entries: AllowanceEntry[];
  ownUserId: string | null;
  loading: boolean;
  emptyMessage: string;
  onOpen: (entry: AllowanceEntry) => void;
  onSave: (entry: AllowanceEntry, input: AllowanceEntryInput) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation("allowances");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const severalPeople = new Set(entries.map((entry) => entry.userId)).size > 1;
  const sorted = [...entries].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.userFullName.localeCompare(b.userFullName));
  const money = (value: number) => value.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!loading && sorted.length === 0) return <EmptyState message={emptyMessage} />;

  const editable = (entry: AllowanceEntry) => entry.userId === ownUserId && entry.status !== "approved";

  const commit = async (entry: AllowanceEntry, field: Field) => {
    const key = `${entry.id}|${field}`;
    if (!(key in drafts)) return;
    const value = Number(drafts[key]);
    setDrafts((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
    if (!Number.isFinite(value) || value < 0 || value === entry[field]) return;
    setSavingId(entry.id);
    await onSave(entry, { ...entryInput(entry), [field]: value });
    setSavingId(null);
  };

  const sum = (pick: (entry: AllowanceEntry) => number) => sorted.reduce((all, entry) => all + pick(entry), 0);

  return (
    <div className={styles.scroller} role="region" aria-label={t("grid.label")} tabIndex={0}>
      <table className={styles.sheet}>
        <thead>
          <tr>
            <th className={styles.sticky}>{t("columns.date")}</th>
            {severalPeople ? <th>{t("columns.employee")}</th> : null}
            <th>{t("columns.site")}</th>
            <th>{t("columns.clockIn")}</th>
            <th>{t("columns.clockOut")}</th>
            {MONEY_COLUMNS.map((column) => (
              <th key={column.field}>{t(`columns.${column.label}`)}</th>
            ))}
            <th>{t("columns.overtimeHours")}</th>
            <th>{t("columns.overtimeDays")}</th>
            <th>{t("columns.overtimeAmount")}</th>
            <th>{t("columns.total")}</th>
            <th>{t("columns.status")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => {
            const canEdit = editable(entry);
            return (
              <tr key={entry.id} data-saving={savingId === entry.id || undefined}>
                <th className={styles.sticky} scope="row">
                  <button type="button" className={styles.dayButton} onClick={() => onOpen(entry)}>
                    <span>{new Date(`${entry.entryDate}T00:00:00`).toLocaleDateString(i18n.language, { weekday: "short" })}</span>
                    <span className={styles.date}>{formatDateOnly(entry.entryDate, i18n.language)}</span>
                  </button>
                </th>
                {severalPeople ? <td className={styles.text}>{entry.userFullName}</td> : null}
                <td className={styles.text}>{entry.siteName || "—"}</td>
                <td>{entry.clockInAt ? formatTimeOnly(entry.clockInAt, i18n.language) : "—"}</td>
                <td>{entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, i18n.language) : "—"}</td>
                {MONEY_COLUMNS.map((column) => {
                  const key = `${entry.id}|${column.field}`;
                  const edited = Boolean(entry.manualOverrides?.[column.label]);
                  return (
                    <td key={column.field} className={edited ? styles.edited : undefined}>
                      {canEdit ? (
                        <input
                          className={styles.cell}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          aria-label={`${t(`columns.${column.label}`)} ${formatDateOnly(entry.entryDate, i18n.language)}`}
                          value={key in drafts ? drafts[key] : String(entry[column.field])}
                          onChange={(event) => setDrafts((all) => ({ ...all, [key]: event.target.value }))}
                          onBlur={() => void commit(entry, column.field)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        money(entry[column.field])
                      )}
                    </td>
                  );
                })}
                <td>{entry.overtimeHours ? Number(entry.overtimeHours.toFixed(2)) : "—"}</td>
                <td>{entry.overtimeDays ? entry.overtimeDays : "—"}</td>
                <td>{money(entry.overtimeAmount + entry.extraDaysAmount)}</td>
                <td className={styles.total}>{money(total(entry))}</td>
                <td>
                  <StatusBadge status={STATUS_BADGE[entry.status]}>{t(`status.${entry.status}`)}</StatusBadge>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className={styles.sticky} scope="row">
              {t("sheet.total")}
            </th>
            {severalPeople ? <td /> : null}
            <td />
            <td />
            <td />
            {MONEY_COLUMNS.map((column) => (
              <td key={column.field}>{money(sum((entry) => entry[column.field]))}</td>
            ))}
            <td>{Number(sum((entry) => entry.overtimeHours).toFixed(2))}</td>
            <td>{sum((entry) => entry.overtimeDays)}</td>
            <td>{money(sum((entry) => entry.overtimeAmount + entry.extraDaysAmount))}</td>
            <td className={styles.total}>{money(sum(total))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
