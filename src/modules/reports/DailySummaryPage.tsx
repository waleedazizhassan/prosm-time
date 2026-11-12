import { useCallback, useEffect, useState, type ReactNode } from "react";
import MoodFace from "../../components/common/MoodFace";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

import DailySummaryRepository, { type DailySummary, type DailySummaryPerson } from "../../core/repositories/DailySummaryRepository";
import { useAuth } from "../../core/context/AuthContext";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import ErrorText from "../../components/common/ErrorText";
import PersonName from "../../components/common/PersonName";
import Table, { type TableColumn } from "../../components/common/Table";
import reportsHeaderImage from "../../assets/illustrations/reports.svg";

// Owner 2026-11-03: the morning summary opens this page. One day of the whole
// organisation - any day, yesterday by default - with the names behind every number.
const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const shiftDay = (day: string, by: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + by));
};
const hours = (minutes: number) => `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;

function Tile({ value, label, tone }: { value: ReactNode; label: string; tone?: "warn" | "danger" }) {
  const color = tone === "danger" ? "var(--status-danger-text)" : tone === "warn" ? "var(--status-warning-text)" : "var(--text-primary)";
  return (
    <div style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-lg)", padding: "var(--space-3) var(--space-4)", background: "var(--surface-card)", minWidth: 0 }}>
      <div style={{ fontSize: "1.6rem", fontWeight: "var(--font-weight-semibold)", color, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{label}</div>
    </div>
  );
}

export default function DailySummaryPage() {
  const { t, i18n } = useTranslation(["reports", "dashboard"]);
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = isoDay(new Date());
  const yesterday = shiftDay(today, -1);
  const requested = params.get("date");
  const day = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : yesterday;
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const result = await DailySummaryRepository.forDay(day);
    setSummary(result.data);
    if (result.error) setError(humanizeBackendError(result.error, t) ?? t("dailySummary.loadError"));
    setLoading(false);
  }, [day, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const go = (next: string) => setParams(next === yesterday ? {} : { date: next }, { replace: true });

  if (profile && !profile.isOwner) {
    return (
      <PageShell title="">
        <PageBanner pageId="dailySummary" illustration={reportsHeaderImage} />
        <Card>
          <p style={{ margin: 0 }}>{t("dailySummary.ownerOnly")}</p>
        </Card>
      </PageShell>
    );
  }

  const columns: TableColumn<DailySummaryPerson>[] = [
    { key: "name", header: t("dailySummary.columns.name"), sortValue: (row) => row.name, render: (row) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <PersonName name={row.name} userId={row.userId} />
        {row.mood ? <span title={`${t("dashboard:attendance.mood.label")}: ${t(`dashboard:attendance.mood.${row.mood}`)}`} style={{ display: "inline-flex", color: "var(--text-secondary)" }}><MoodFace mood={row.mood} size={20} active /></span> : null}
      </span>
    ) },
    { key: "site", header: t("dailySummary.columns.site"), sortValue: (row) => row.site ?? "", render: (row) => row.site ?? t("dailySummary.noSite") },
    { key: "in", header: t("dailySummary.columns.in"), sortValue: (row) => row.firstIn, render: (row) => formatTimeOnly(row.firstIn, i18n.language) },
    {
      key: "out",
      header: t("dailySummary.columns.out"),
      render: (row) => (row.stillIn ? <span style={{ color: "var(--status-success-text)" }}>{t("dailySummary.stillIn")}</span> : row.lastOut ? `${formatTimeOnly(row.lastOut, i18n.language)}${row.autoClosed ? ` · ${t("dailySummary.autoClosed")}` : ""}` : "—"),
    },
    { key: "hours", header: t("dailySummary.columns.hours"), sortValue: (row) => row.minutes, render: (row) => hours(row.minutes) },
    {
      key: "late",
      header: t("dailySummary.columns.late"),
      sortValue: (row) => row.lateMinutes ?? -1,
      render: (row) => (row.lateMinutes ? <span style={{ color: "var(--status-warning-text)" }}>{t("dailySummary.lateBy", { time: hours(row.lateMinutes) })}</span> : "—"),
    },
  ];

  const nameList = (items: { userId: string; name: string; detail: string }[], empty: string) =>
    items.length === 0 ? (
      <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{empty}</p>
    ) : (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {items.map((item, index) => (
          <div key={`${item.userId}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)", flexWrap: "wrap", padding: "var(--space-2) 0", borderTop: index ? "1px solid var(--border-light)" : "none" }}>
            <PersonName name={item.name} userId={item.userId} />
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{item.detail}</span>
          </div>
        ))}
      </div>
    );

  return (
    <PageShell title="">
      <PageBanner pageId="dailySummary" illustration={reportsHeaderImage} />

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => go(shiftDay(day, -1))} aria-label={t("dailySummary.previousDay")} title={t("dailySummary.previousDay")}>
            {i18n.dir() === "rtl" ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </Button>
          <div style={{ flex: "0 1 220px", minWidth: 0 }}>
            <Input label={t("dailySummary.day")} name="summaryDay" type="date" value={day} onChange={(event) => event.target.value && go(event.target.value)} />
          </div>
          <Button variant="ghost" onClick={() => go(shiftDay(day, 1))} disabled={day >= today} aria-label={t("dailySummary.nextDay")} title={t("dailySummary.nextDay")}>
            {i18n.dir() === "rtl" ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </Button>
          <Button variant={day === yesterday ? "primary" : "ghost"} onClick={() => go(yesterday)}>
            {t("dailySummary.yesterday")}
          </Button>
          <Button variant={day === today ? "primary" : "ghost"} onClick={() => go(today)}>
            {t("dailySummary.today")}
          </Button>
        </div>
        <p style={{ margin: "var(--space-3) 0 0", fontWeight: "var(--font-weight-semibold)" }}>{formatDateOnly(day, i18n.language)}</p>
      </Card>

      <ErrorText>{error}</ErrorText>

      {summary ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--space-3)" }}>
            <Tile value={summary.worked} label={t("dailySummary.worked")} />
            <Tile value={hours(summary.minutes)} label={t("dailySummary.totalHours")} />
            <Tile value={summary.late} label={t("dailySummary.late")} tone={summary.late ? "warn" : undefined} />
            <Tile value={summary.noShows} label={t("dailySummary.noShows")} tone={summary.noShows ? "danger" : undefined} />
            <Tile value={summary.onLeave} label={t("dailySummary.onLeave")} />
          </div>

          <Card title={t("dailySummary.peopleTitle")}>
            <Table columns={columns} data={summary.people} getRowId={(row) => row.userId} loading={loading} emptyTitle={t("dailySummary.nobodyWorked")} emptyMessage="" />
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: "var(--space-3)" }}>
            <Card title={t("dailySummary.noShowsTitle")}>
              {nameList(
                summary.noShowList.map((row) => ({ userId: row.userId, name: row.name, detail: `${row.site ?? t("dailySummary.noSite")} · ${row.start}–${row.end}` })),
                t("dailySummary.noNoShows"),
              )}
            </Card>
            <Card title={t("dailySummary.leaveTitle")}>
              {nameList(
                summary.leaveList.map((row) => ({ userId: row.userId, name: row.name, detail: row.leave })),
                t("dailySummary.noLeave"),
              )}
            </Card>
          </div>

          <Card title={t("dailySummary.waitingTitle")} subtitle={t("dailySummary.waitingHint")}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", fontSize: "var(--font-sm)" }}>
              <Link to="/manager">{t("dailySummary.waitingLeave", { count: summary.waiting.leave })}</Link>
              <Link to="/manager">{t("dailySummary.waitingExceptions", { count: summary.waiting.exceptions })}</Link>
              <Link to="/attendance?period=today">{t("dailySummary.clockedInNow", { count: summary.waiting.clockedInNow })}</Link>
            </div>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
