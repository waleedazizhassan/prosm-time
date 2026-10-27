import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "../../../components/common/Avatar";
import Button from "../../../components/common/Button";
import EmptyState from "../../../components/common/EmptyState";
import Modal from "../../../components/common/Modal";
import type { ManagerDashboard as Dashboard } from "../../../core/repositories/DashboardRepository";
import styles from "./ManagerDashboard.module.css";

export type KpiSheetKind = "present" | "hours" | "late" | "overtime";

const hours = (minutes: number) => Math.round((Number(minutes) / 60) * 10) / 10;

// Owner 2026-10-27 ("can the KPI cards show their data?"): a card opens the
// people behind its number - the same figures, person by person - with a
// button to the page that has the whole record.
export default function KpiSheet({
  kind,
  data,
  time,
  onClose,
  onOpenPage,
}: {
  kind: KpiSheetKind | null;
  data: Dashboard | null;
  time: (value: string) => string;
  onClose: () => void;
  onOpenPage: (kind: KpiSheetKind) => void;
}) {
  const { t } = useTranslation("dashboard");
  if (!kind || !data) return null;
  const people = data.byPerson ?? [];

  const person = (name: string, avatarUrl: string | null) => (
    <td style={{ fontWeight: 600 }}>
      <span className={styles.personCell}>
        <Avatar name={name} url={avatarUrl} size="sm" />
        {name}
      </span>
    </td>
  );
  const head = (...labels: string[]) => (
    <thead>
      <tr>
        {labels.map((label) => (
          <th key={label}>{label}</th>
        ))}
      </tr>
    </thead>
  );
  const col = (key: string) => t(`manager.sheet.columns.${key}`);

  let rows: ReactNode = null;
  let count = 0;
  if (kind === "present") {
    count = data.presentNow.length;
    rows = (
      <table className={styles.table}>
        {head(col("name"), col("site"), col("since"), col("status"))}
        <tbody>
          {data.presentNow.map((row) => (
            <tr key={row.userId}>
              {person(row.name, row.avatarUrl)}
              <td data-label={col("site")}>{row.siteName ?? "—"}</td>
              <td data-label={col("since")}>{time(row.clockInAt)}</td>
              <td data-label={col("status")}>
                <span className={row.status === "in" ? styles.statusOk : row.status === "break" ? styles.statusWarn : styles.statusBad}>{t(`manager.present.status.${row.status}`)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (kind === "hours") {
    const shown = people.filter((row) => Number(row.workedMinutes) > 0 || Number(row.pendingMinutes) > 0);
    count = shown.length;
    rows = (
      <table className={styles.table}>
        {head(col("name"), col("days"), col("worked"), col("overtime"), col("pending"))}
        <tbody>
          {shown.map((row) => (
            <tr key={row.userId}>
              {person(row.name, row.avatarUrl)}
              <td data-label={col("days")}>{row.days}</td>
              <td data-label={col("worked")}>{hours(row.workedMinutes)}</td>
              <td data-label={col("overtime")}>{hours(row.overtimeMinutes)}</td>
              <td data-label={col("pending")}>{Number(row.pendingMinutes) > 0 ? hours(row.pendingMinutes) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (kind === "late") {
    // late today first, then the period's late days
    const shown = people.filter((row) => Number(row.lateDays) > 0).sort((a, b) => Number(b.lateTodayMinutes ?? 0) - Number(a.lateTodayMinutes ?? 0) || Number(b.lateMinutes) - Number(a.lateMinutes));
    count = shown.length;
    rows = (
      <table className={styles.table}>
        {head(col("name"), col("today"), col("lateDays"), col("lateTotal"))}
        <tbody>
          {shown.map((row) => (
            <tr key={row.userId}>
              {person(row.name, row.avatarUrl)}
              <td data-label={col("today")}>
                {Number(row.lateTodayMinutes ?? 0) > 0 ? (
                  <span className={styles.statusWarn}>{t("manager.sheet.lateBy", { minutes: Math.round(Number(row.lateTodayMinutes)), time: row.firstInToday ? time(row.firstInToday) : "—" })}</span>
                ) : (
                  "—"
                )}
              </td>
              <td data-label={col("lateDays")}>{row.lateDays}</td>
              <td data-label={col("lateTotal")}>{t("manager.sheet.minutes", { count: Math.round(Number(row.lateMinutes)) })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    const shown = people.filter((row) => Number(row.overtimeMinutes) > 0 || Number(row.overtimePendingMinutes) > 0).sort((a, b) => Number(b.overtimeMinutes) - Number(a.overtimeMinutes));
    count = shown.length;
    rows = (
      <table className={styles.table}>
        {head(col("name"), col("overtime"), col("overtimeWaiting"))}
        <tbody>
          {shown.map((row) => (
            <tr key={row.userId}>
              {person(row.name, row.avatarUrl)}
              <td data-label={col("overtime")}>{hours(row.overtimeMinutes)}</td>
              <td data-label={col("overtimeWaiting")}>{Number(row.overtimePendingMinutes) > 0 ? <span className={styles.statusWarn}>{hours(row.overtimePendingMinutes)}</span> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t(`manager.sheet.title.${kind}`)}
      size="lg"
      footer={
        <Button variant="ghost" onClick={() => onOpenPage(kind)}>
          {t(`manager.sheet.open.${kind}`)}
        </Button>
      }
    >
      {kind !== "present" ? <p className={styles.rowMeta}>{t("manager.sheet.periodNote")}</p> : null}
      {count === 0 ? <EmptyState message={t(`manager.sheet.empty.${kind}`)} /> : rows}
    </Modal>
  );
}
