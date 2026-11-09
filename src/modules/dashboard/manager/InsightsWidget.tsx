import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlarmClock, CalendarCheck, Timer, type LucideIcon } from "lucide-react";

import InsightsRepository, { type AttendanceInsights, type PersonFigure } from "../../../core/repositories/InsightsRepository";
import EmptyState from "../../../components/common/EmptyState";
import styles from "./ManagerDashboard.module.css";

// docs/IDEAS.md 3: the period's attendance rate, and who is often late or on overtime.
// Owner 2026-11-09 ("attendance indicators should be KPIs with charts"): three tiles - the rate as a ring,
// the repeat late and the repeat overtime as bars per person with the period's total on top.
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

  const rate = data.rate;
  const ringTone = rate === null ? "var(--text-tertiary, #94a3b8)" : rate >= 95 ? "var(--status-success-text)" : rate >= 80 ? "var(--status-warning-text, #b45309)" : "var(--brand-danger)";
  const circumference = 2 * Math.PI * 42;

  return (
    <div className={styles.insights}>
      <div className={styles.insightTile}>
        <TileHead icon={CalendarCheck} title={t("manager.insights.rate")} />
        <div className={styles.ringRow}>
          <svg viewBox="0 0 100 100" className={styles.ring} role="img" aria-label={rate === null ? t("manager.insights.noSchedule") : `${rate}%`}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-sunken)" strokeWidth="10" />
            {rate !== null ? (
              <circle cx="50" cy="50" r="42" fill="none" stroke={ringTone} strokeWidth="10" strokeLinecap="round"
                strokeDasharray={`${(Math.min(100, rate) / 100) * circumference} ${circumference}`} transform="rotate(-90 50 50)" />
            ) : null}
            <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="20" fontWeight="700" fill="var(--text-primary)">{rate === null ? "—" : `${rate}%`}</text>
          </svg>
          <div className={styles.ringText}>
            <span className={styles.kpiHint}>
              {data.scheduled > 0 ? t("manager.insights.rateHint", { attended: data.attended, scheduled: data.scheduled }) : t("manager.insights.noSchedule")}
            </span>
          </div>
        </div>
      </div>
      <PeopleBars icon={AlarmClock} title={t("manager.insights.repeatLate")} people={data.repeatLate} tone="var(--status-warning-text, #b45309)"
        total={t("manager.insights.lateTotal", { minutes: data.repeatLate.reduce((sum, p) => sum + p.minutes, 0) })} unit="late" />
      <PeopleBars icon={Timer} title={t("manager.insights.repeatOvertime")} people={data.repeatOvertime} tone="var(--brand-primary)"
        total={t("manager.insights.overtimeTotal", { hours: Math.round((data.repeatOvertime.reduce((sum, p) => sum + p.minutes, 0) / 60) * 10) / 10 })} unit="overtime" />
    </div>
  );
}

function TileHead({ icon: Icon, title, aside }: { icon: LucideIcon; title: string; aside?: string }) {
  return (
    <div className={styles.kpiHead}>
      <span className={styles.kpiIcon} aria-hidden="true"><Icon size={14} /></span>
      <span className={styles.kpiLabel} style={{ flex: 1 }}>{title}</span>
      {aside ? <span className={styles.kpiHint}>{aside}</span> : null}
    </div>
  );
}

function PeopleBars({ icon, title, people, tone, total, unit }: { icon: LucideIcon; title: string; people: PersonFigure[]; tone: string; total: string; unit: "late" | "overtime" }) {
  const { t } = useTranslation("dashboard");
  const max = Math.max(1, ...people.map((p) => p.minutes));
  const shown = people.slice(0, 5);
  return (
    <div className={styles.insightTile}>
      <TileHead icon={icon} title={title} aside={people.length ? total : undefined} />
      {shown.length === 0 ? (
        <p className={styles.kpiHint} style={{ margin: "var(--space-2) 0 0" }}>{t("manager.insights.none")}</p>
      ) : (
        <ul className={styles.personBars}>
          {shown.map((person) => (
            <li key={person.name} title={t(`manager.insights.${unit}Meta`, { days: person.days, minutes: person.minutes })}>
              <span className={styles.personBarName}>{person.name}</span>
              <span className={styles.bar} style={{ flex: 1 }}>
                <span style={{ width: `${Math.max(4, Math.round((person.minutes / max) * 100))}%`, background: tone }} />
              </span>
              <span className={styles.personBarValue}>{t(`manager.insights.${unit}Short`, { days: person.days, minutes: person.minutes })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
