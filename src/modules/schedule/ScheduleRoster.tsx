import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import type { ShiftActual, ShiftTemplate, SiteShiftRow } from "../../core/repositories/ShiftRepository";
import { appLocale, formatTimeOnly } from "../../core/utils/formatDate";
import styles from "./ScheduleRoster.module.css";

export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekDays(start: string): string[] {
  const base = new Date(`${start}T00:00:00`);
  return Array.from({ length: 7 }, (_, i) => isoDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
}

// Owner 2026-11-09 ("the shift schedule page needs fixing"): the week as a roster - a row per person,
// a column per day, each shift a coloured block with its hours and whether it was worked. An empty
// cell adds a shift for that person and day; a shift opens to be cancelled.
export default function ScheduleRoster({
  days,
  shifts,
  actuals,
  templates,
  loading,
  onAdd,
  onOpen,
}: {
  days: string[];
  shifts: SiteShiftRow[];
  actuals: ShiftActual[];
  templates: ShiftTemplate[];
  loading: boolean;
  onAdd: (userId: string | null, day: string) => void;
  onOpen: (shift: SiteShiftRow) => void;
}) {
  const { t, i18n } = useTranslation("schedule");
  const today = isoDay(new Date());
  const live = shifts.filter((shift) => shift.status === "scheduled");
  const people = [...new Map(live.map((shift) => [shift.userId, shift.employeeName])).entries()].sort((a, b) => a[1].localeCompare(b[1], i18n.language));
  const colorOf = (shift: SiteShiftRow) =>
    templates.find((tpl) => tpl.startTime.slice(0, 5) === shift.startTime.slice(0, 5) && tpl.endTime.slice(0, 5) === shift.endTime.slice(0, 5))?.color ?? null;
  const perDay = (day: string) => live.filter((shift) => shift.shiftDate === day).length;

  // owner 2026-11-10: on a phone the week opened on its first (past) days - it now opens on today
  const scrollerRef = useRef<HTMLDivElement>(null);
  const weekKey = days[0];
  useEffect(() => {
    const box = scrollerRef.current;
    const cell = box?.querySelector<HTMLElement>("thead th[data-today]");
    const name = box?.querySelector<HTMLElement>("thead th");
    if (!box || !cell || !name || box.scrollWidth <= box.clientWidth) return;
    const rtl = getComputedStyle(box).direction === "rtl";
    const boxRect = box.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const nameWidth = name.getBoundingClientRect().width;
    const offset = rtl ? boxRect.right - nameWidth - cellRect.right : cellRect.left - boxRect.left - nameWidth;
    box.scrollLeft += rtl ? -offset : offset;
  }, [weekKey, loading]);

  return (
    <>
    {/* owner 2026-11-10: an empty week says so above the roster, not as a big picture squeezed under it */}
    {!loading && people.length === 0 ? <p className={styles.emptyNote}>{t("roster.empty")}</p> : null}
    <div ref={scrollerRef} className={styles.scroller} role="region" aria-label={t("roster.label")} tabIndex={0}>
      <table className={styles.roster}>
        <thead>
          <tr>
            <th className={styles.personCol}>{t("columns.employee")}</th>
            {days.map((day) => {
              const date = new Date(`${day}T00:00:00`);
              return (
                <th key={day} className={day === today ? styles.today : undefined} data-today={day === today ? "" : undefined}>
                  <span className={styles.dayName}>{date.toLocaleDateString(appLocale(i18n.language), { weekday: "short" })}</span>
                  <span className={styles.dayDate}>{date.toLocaleDateString(appLocale(i18n.language), { day: "numeric", month: "short" })}</span>
                  <span className={styles.dayCount}>{t("roster.count", { count: perDay(day) })}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {people.map(([userId, name]) => (
            <tr key={userId}>
              <th scope="row" className={styles.personCol}>{name}</th>
              {days.map((day) => {
                const cell = live.filter((shift) => shift.userId === userId && shift.shiftDate === day);
                return (
                  <td key={day} className={day === today ? styles.today : undefined}>
                    {cell.map((shift) => {
                      const actual = actuals.find((entry) => entry.assignmentId === shift.id);
                      const color = colorOf(shift);
                      return (
                        <button key={shift.id} type="button" className={styles.shift} style={color ? { borderInlineStartColor: color } : undefined} onClick={() => onOpen(shift)}
                          title={shift.notes ?? undefined}>
                          <span className={styles.shiftTime}>
                            {shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)}{shift.crossesMidnight ? " +1" : ""}
                          </span>
                          {actual ? (
                            <span className={styles.worked}>
                              ✓ {formatTimeOnly(actual.firstIn, i18n.language)}{actual.lastOut ? `–${formatTimeOnly(actual.lastOut, i18n.language)}` : ""}
                            </span>
                          ) : day < today ? (
                            <span className={styles.missed}>{t("roster.notWorked")}</span>
                          ) : null}
                        </button>
                      );
                    })}
                    {cell.length === 0 && day >= today ? (
                      <button type="button" className={styles.add} onClick={() => onAdd(userId, day)} aria-label={t("roster.addFor", { name, day })}>
                        <Plus size={14} />
                      </button>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className={styles.addRow}>
            <th scope="row" className={styles.personCol}>
              <span className={styles.addLabel}><Plus size={13} aria-hidden="true" /> {t("roster.someoneElse")}</span>
            </th>
            {days.map((day) => (
              <td key={day} className={day === today ? styles.today : undefined}>
                {day >= today ? (
                  <button type="button" className={styles.add} onClick={() => onAdd(null, day)} aria-label={t("roster.addOn", { day })}>
                    <Plus size={14} />
                  </button>
                ) : null}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
    </>
  );
}
