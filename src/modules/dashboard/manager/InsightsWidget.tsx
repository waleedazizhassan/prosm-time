import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import InsightsRepository, { type AttendanceInsights, type PersonFigure } from "../../../core/repositories/InsightsRepository";
import EmptyState from "../../../components/common/EmptyState";
import styles from "./ManagerDashboard.module.css";

// docs/IDEAS.md 3: the period's attendance rate, and who is often late or on overtime.
export default function InsightsWidget({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation("dashboard");
  const [data, setData] = useState<AttendanceInsights | null | "error">(null);

  useEffect(() => {
    let live = true;
    setData(null);
    void InsightsRepository.attendance(from, to).then((result) => {
      if (live) setData(result ?? "error");
    });
    return () => {
      live = false;
    };
  }, [from, to]);

  if (data === null) return <div className={styles.skeleton} style={{ height: 160 }} />;
  if (data === "error") return <EmptyState message={t("manager.insights.unavailable")} />;

  const list = (title: string, people: PersonFigure[], unit: "late" | "overtime") => (
    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
      <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{title}</h3>
      {people.length === 0 ? (
        <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("manager.insights.none")}</p>
      ) : (
        <ul className={styles.rowList}>
          {people.map((person) => (
            <li key={person.name}>
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{person.name}</span>
                <span className={styles.rowMeta}>{t(`manager.insights.${unit}Meta`, { days: person.days, minutes: person.minutes })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)" }}>
      <div style={{ flex: "0 1 160px" }}>
        <span className={styles.kpiLabel}>{t("manager.insights.rate")}</span>
        <span className={styles.kpiValue} style={{ display: "block" }}>{data.rate === null ? "—" : `${data.rate}%`}</span>
        <span className={styles.kpiHint}>{t("manager.insights.rateHint", { attended: data.attended, scheduled: data.scheduled })}</span>
      </div>
      {list(t("manager.insights.repeatLate"), data.repeatLate, "late")}
      {list(t("manager.insights.repeatOvertime"), data.repeatOvertime, "overtime")}
    </div>
  );
}
