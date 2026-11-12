import { useTranslation } from "react-i18next";

import type { AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import { appLocale } from "../../core/utils/formatDate";
import styles from "./AllowanceSummary.module.css";

// Owner 2026-11-09 ("the allowances need a look worthy of PROSM"): the period at a glance on top -
// the total, the days and where they stand, and what the money is made of, as one bar with a legend.
const PARTS: { key: string; color: string; pick: (entry: AllowanceEntry) => number }[] = [
  { key: "expatriation", color: "#3b82f6", pick: (e) => e.expatriationAllowance },
  { key: "transportation", color: "#22c55e", pick: (e) => e.transportationAllowance },
  { key: "travel", color: "#14b8a6", pick: (e) => e.travelAllowance },
  { key: "meal", color: "#f59e0b", pick: (e) => e.mealAllowance },
  { key: "housing", color: "#a855f7", pick: (e) => e.housingAllowance },
  { key: "other", color: "#94a3b8", pick: (e) => e.otherAllowance },
  { key: "overtimeAmount", color: "#ef4444", pick: (e) => e.overtimeAmount + e.extraDaysAmount - e.lateAmount },
];

export default function AllowanceSummary({ entries }: { entries: AllowanceEntry[] }) {
  const { t, i18n } = useTranslation("allowances");
  const fmt = (value: number, digits = 2) => value.toLocaleString(appLocale(i18n.language), { minimumFractionDigits: 0, maximumFractionDigits: digits });
  const parts = PARTS.map((part) => ({ ...part, value: entries.reduce((sum, entry) => sum + part.pick(entry), 0) })).filter((part) => part.value > 0);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const days = new Set(entries.map((entry) => `${entry.userId}|${entry.entryDate}`)).size;
  const count = (status: AllowanceEntry["status"]) => entries.filter((entry) => entry.status === status).length;
  const states: { key: AllowanceEntry["status"]; tone: string }[] = [
    { key: "draft", tone: styles.toneDraft },
    { key: "submitted", tone: styles.toneSent },
    { key: "approved", tone: styles.toneOk },
    { key: "rejected", tone: styles.toneBad },
  ];

  return (
    <section className={styles.summary} aria-label={t("summary.title")}>
      <div className={styles.head}>
        <div>
          <span className={styles.label}>{t("summary.title")}</span>
          <span className={styles.total}>{fmt(total)}</span>
          <span className={styles.meta}>{t("summary.days", { count: days })}</span>
        </div>
        <div className={styles.states}>
          {states.map(({ key, tone }) => {
            const n = count(key);
            if (n === 0 && key === "rejected") return null;
            return (
              <span key={key} className={`${styles.state} ${tone}`}>
                <b>{n}</b> {t(`status.${key}`)}
              </span>
            );
          })}
        </div>
      </div>
      {total > 0 ? (
        <>
          <div className={styles.stack} role="img" aria-label={parts.map((part) => `${t(`columns.${part.key}`)} ${fmt(part.value)}`).join(" · ")}>
            {parts.map((part) => (
              <span key={part.key} style={{ width: `${(part.value / total) * 100}%`, background: part.color }} title={`${t(`columns.${part.key}`)}: ${fmt(part.value)}`} />
            ))}
          </div>
          <ul className={styles.legend}>
            {parts.map((part) => (
              <li key={part.key}>
                <i style={{ background: part.color }} />
                <span className={styles.legendName}>{t(`columns.${part.key}`)}</span>
                <b>{fmt(part.value)}</b>
                <span className={styles.meta}>{Math.round((part.value / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
