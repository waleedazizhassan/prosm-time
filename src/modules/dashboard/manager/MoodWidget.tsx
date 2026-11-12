import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2, CalendarDays, MapPin, Smile, type LucideIcon } from "lucide-react";

import InsightsRepository, { type MoodCounts, type MoodInsights } from "../../../core/repositories/InsightsRepository";
import EmptyState from "../../../components/common/EmptyState";
import MoodFace, { type ShiftMood } from "../../../components/common/MoodFace";
import { formatDateOnly } from "../../../core/utils/formatDate";
import styles from "./ManagerDashboard.module.css";

const TONE: Record<ShiftMood, string> = { great: "#16a34a", normal: "#d97706", tough: "#dc2626" };
const MOODS: ShiftMood[] = ["great", "normal", "tough"];
const scoreTone = (score: number) => (score >= 75 ? TONE.great : score >= 50 ? TONE.normal : TONE.tough);

// Owner 2026-11-12: "the faces rating as a KPI for every site, every day, week and month - and every client".
// The dashboard's period (day, week, month or custom) drives it: the score, by site, by client and by day.
export default function MoodWidget({ from, to }: { from: string; to: string }) {
  const { t, i18n } = useTranslation(["dashboard", "sites"]);
  const [data, setData] = useState<MoodInsights | null | "error">(null);

  useEffect(() => {
    let live = true;
    setData(null);
    void InsightsRepository.moods(from, to).then((result) => {
      if (live) setData(result ?? "error");
    });
    return () => {
      live = false;
    };
  }, [from, to]);

  if (data === null) return <div className={styles.skeleton} style={{ height: 160 }} />;
  if (data === "error") return <EmptyState message={t("manager.insights.unavailable")} />;
  if (data.total === 0) return <EmptyState message={t("manager.mood.empty")} />;

  const score = data.score ?? 0;
  const circumference = 2 * Math.PI * 42;
  const maxDay = Math.max(1, ...data.byDay.map((d) => d.total));

  return (
    <div className={styles.insights}>
      <div className={styles.insightTile}>
        <TileHead icon={Smile} title={t("manager.mood.score")} aside={t("manager.mood.ratings", { count: data.total })} />
        <div className={styles.ringRow}>
          <svg viewBox="0 0 100 100" className={styles.ring} role="img" aria-label={`${score}%`}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-sunken)" strokeWidth="10" />
            <circle cx="50" cy="50" r="42" fill="none" stroke={scoreTone(score)} strokeWidth="10" strokeLinecap="round"
              strokeDasharray={`${(score / 100) * circumference} ${circumference}`} transform="rotate(-90 50 50)" />
            <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="20" fontWeight="700" fill="var(--text-primary)">{`${score}%`}</text>
          </svg>
          <div className={styles.ringText}>
            {MOODS.map((mood) => (
              <span key={mood} className={styles.kpiHint} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <MoodFace mood={mood} size={18} active /> {t(`attendance.mood.${mood}`)} · <strong>{data[mood]}</strong>
              </span>
            ))}
          </div>
        </div>
        <span className={styles.kpiHint}>{t("manager.mood.scoreHint")}</span>
      </div>

      <ScoreBars icon={MapPin} title={t("manager.mood.bySite")}
        rows={data.bySite.map((s) => ({ key: s.siteId ?? "none", name: s.name ?? t("manager.mood.noSite"), meta: s.clientName ?? undefined, counts: s, score: s.score }))} />

      <ScoreBars icon={Building2} title={t("manager.mood.byClient")}
        rows={data.byClient.map((c) => ({ key: c.client ?? "company", name: c.client ?? t("sites:ownerKind.company"), counts: c, score: c.score }))} />

      <div className={styles.insightTile}>
        <TileHead icon={CalendarDays} title={t("manager.mood.byDay")} />
        <div className={styles.moodDays} role="img" aria-label={t("manager.mood.byDay")}>
          {data.byDay.map((d) => (
            <div key={d.day} className={styles.moodDay}
              title={`${formatDateOnly(d.day, i18n.language)} · ${MOODS.map((m) => `${t(`attendance.mood.${m}`)} ${d[m]}`).join(" · ")}`}>
              <div className={styles.moodStack} style={{ height: `${Math.max(8, Math.round((d.total / maxDay) * 100))}%` }}>
                {MOODS.map((m) => (d[m] > 0 ? <span key={m} style={{ flex: d[m], background: TONE[m] }} /> : null))}
              </div>
              <span className={styles.moodDayLabel}>{new Date(`${d.day}T12:00:00`).getDate()}</span>
            </div>
          ))}
        </div>
      </div>
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

function ScoreBars({ icon, title, rows }: { icon: LucideIcon; title: string; rows: { key: string; name: string; meta?: string; counts: MoodCounts; score: number }[] }) {
  const { t } = useTranslation("dashboard");
  return (
    <div className={styles.insightTile}>
      <TileHead icon={icon} title={title} />
      <ul className={styles.personBars}>
        {rows.slice(0, 6).map((row) => (
          <li key={row.key} title={`${row.meta ? `${row.meta} · ` : ""}${MOODS.map((m) => `${t(`attendance.mood.${m}`)} ${row.counts[m]}`).join(" · ")}`}>
            <span className={styles.personBarName}>{row.name}</span>
            <span className={styles.bar} style={{ flex: 1 }}>
              <span style={{ width: `${Math.max(4, row.score)}%`, background: scoreTone(row.score) }} />
            </span>
            <span className={styles.personBarValue}>{t("manager.mood.scoreShort", { score: row.score, count: row.counts.total })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
