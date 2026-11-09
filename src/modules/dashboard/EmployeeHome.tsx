import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellRing, Hourglass } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useDashboardRefresh } from "../../core/hooks/useDashboardRefresh";
import ManagerRepository, { type TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import Modal from "../../components/common/Modal";
import ClockInOutCard from "./ClockInOutCard";
import PersonalRemindersCard from "./PersonalRemindersCard";
import { PERIODS, formatHours, periodHours, periodRange } from "../attendance/periods";
import styles from "./EmployeeHome.module.css";

const HOURS_VISIBLE_MS = 15000;

// Owner 2026-11-09: the employee's page is one screen - the clock-in map. Their hours and their
// reminders are two small floating buttons (hours show for 15 seconds); their records are in the
// menu and the bottom bar, not repeated here.
export default function EmployeeHome() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();
  const profileId = profile?.id;
  const [rows, setRows] = useState<TodayAttendanceRow[]>([]);
  const [tick, setTick] = useState(0);
  const [showHours, setShowHours] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const hideTimer = useRef<number | null>(null);
  useDashboardRefresh(() => setTick((value) => value + 1));

  useEffect(() => {
    if (!profileId) return;
    const week = periodRange("week");
    const month = periodRange("month");
    const start = week.start < month.start ? week.start : month.start;
    void ManagerRepository.listAttendanceHistory(start, month.end).then((history) => {
      setRows(history.success ? (history.data ?? []).filter((row) => row.userId === profileId) : []);
    });
  }, [profileId, tick]);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  // owner 2026-11-09: a tap anywhere on the screen closes the hours
  useEffect(() => {
    if (!showHours) return undefined;
    const close = () => setShowHours(false);
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", close, { once: true }), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", close);
    };
  }, [showHours]);

  const toggleHours = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (showHours) {
      setShowHours(false);
      return;
    }
    setShowHours(true);
    hideTimer.current = window.setTimeout(() => setShowHours(false), HOURS_VISIBLE_MS);
  };

  return (
    <>
      <ClockInOutCard />

      <div className={styles.floatingTools}>
        <button type="button" className={styles.toolButton} onClick={toggleHours} aria-label={t("employeeHome.hoursTitle")} title={t("employeeHome.hoursTitle")} aria-expanded={showHours}>
          <Hourglass size={20} />
        </button>
        <button type="button" className={styles.toolButton} onClick={() => setShowReminders(true)} aria-label={t("reminders.title")} title={t("reminders.title")}>
          <BellRing size={20} />
        </button>
      </div>

      {showHours ? (
        <div className={styles.hoursPopover} role="status" onClick={toggleHours}>
          <strong>{t("employeeHome.hoursTitle")}</strong>
          <div className={styles.hours}>
            {PERIODS.map((period) => (
              <div key={period} className={styles.hourTile}>
                <span className={styles.hourLabel}>{t(`employeeHome.periods.${period}`)}</span>
                <span className={styles.hourValue}>{formatHours(periodHours(rows, period))}</span>
                <span className={styles.hourUnit}>{t("employeeHome.hoursUnit")}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Modal isOpen={showReminders} onClose={() => setShowReminders(false)} title={t("reminders.title")}>
        <PersonalRemindersCard />
      </Modal>
    </>
  );
}
