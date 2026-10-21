import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, FileText, MapPin, Wallet } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import ManagerRepository, { type TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import Card from "../../components/common/Card";
import ClockInOutCard from "./ClockInOutCard";
import { PERIODS, formatHours, periodHours, periodRange } from "../attendance/periods";
import WeatherMiniPanel from "../../layouts/AppShell/WeatherMiniPanel";
import heroStyles from "./AdminOverviewCard.module.css";
import styles from "./EmployeeHome.module.css";
import homeArt from "../../assets/illustrations/employeeHome.svg";

// Owner 2026-10-19: the employee's page is light and easy - clock in and
// out, see their own time by day / week / month, and reach their own
// records (each with its PDF download): attendance, allowances,
// timesheets and leave.
export default function EmployeeHome() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();
  const profileId = profile?.id;
  const [rows, setRows] = useState<TodayAttendanceRow[]>([]);
  const [organizationName, setOrganizationName] = useState("");
  const [siteNames, setSiteNames] = useState<string[]>([]);

  useEffect(() => {
    if (!profileId) return;
    const week = periodRange("week");
    const month = periodRange("month");
    const start = week.start < month.start ? week.start : month.start;
    Promise.all([
      ManagerRepository.listAttendanceHistory(start, month.end),
      OrganizationRepository.getCurrentOrganization(),
      SiteRepository.listAllAssignedSiteNames(),
    ]).then(([history, organization, assigned]) => {
      setRows(history.success ? (history.data ?? []).filter((row) => row.userId === profileId) : []);
      setOrganizationName(organization.success ? organization.data?.name ?? "" : "");
      setSiteNames(assigned.success ? assigned.data?.[profileId] ?? [] : []);
    });
  }, [profileId]);

  const hour = new Date().getHours();
  const greetingKey = hour < 12 ? "overview.greetingMorning" : hour < 17 ? "overview.greetingAfternoon" : "overview.greetingEvening";
  const firstName = (profile?.fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const todayLabel = new Date().toLocaleDateString(i18n.language, { weekday: "long", day: "numeric", month: "long" });
  const scope = [organizationName, siteNames.join(i18n.dir() === "rtl" ? "، " : ", ")].filter(Boolean).join(" · ");
  const Chevron = i18n.dir() === "rtl" ? ChevronLeft : ChevronRight;

  const links = [
    { to: "/attendance", icon: Clock, label: t("employeeHome.links.attendance"), hint: t("employeeHome.links.attendanceHint") },
    { to: "/allowances", icon: Wallet, label: t("employeeHome.links.allowances"), hint: t("employeeHome.links.allowancesHint") },
    { to: "/timesheets", icon: FileText, label: t("employeeHome.links.timesheets"), hint: t("employeeHome.links.timesheetsHint") },
    { to: "/leave", icon: CalendarDays, label: t("employeeHome.links.leave"), hint: t("employeeHome.links.leaveHint") },
  ];

  return (
    <>
      <div className={heroStyles.hero}>
        <div className={heroStyles.heroText}>
          <h2 className={heroStyles.heroTitle}>{t(greetingKey, { name: firstName })}</h2>
          <span className={heroStyles.heroDate}>{todayLabel}</span>
          {/* Owner 2026-10-21: the weather moved from the header to the dashboard. */}
          <div className={heroStyles.heroWeather}>
            <WeatherMiniPanel />
          </div>
          {scope ? (
            <span className={heroStyles.heroScope}>
              <MapPin size={13} />
              <span className={heroStyles.heroScopeText}>{scope}</span>
            </span>
          ) : null}
        </div>
        <img src={homeArt} alt="" className={heroStyles.heroArt} />
      </div>

      <ClockInOutCard />

      <Card title={t("employeeHome.hoursTitle")}>
        <div className={styles.hours}>
          {PERIODS.map((period) => (
            <Link key={period} to={`/attendance?period=${period}`} className={styles.hourTile}>
              <span className={styles.hourLabel}>{t(`employeeHome.periods.${period}`)}</span>
              <span className={styles.hourValue}>{formatHours(periodHours(rows, period))}</span>
              <span className={styles.hourUnit}>{t("employeeHome.hoursUnit")}</span>
            </Link>
          ))}
        </div>
      </Card>

      <Card title={t("employeeHome.linksTitle")}>
        <div className={styles.links}>
          {links.map((link) => (
            <Link key={link.to} to={link.to} className={styles.link}>
              <span className={styles.linkIcon}>
                <link.icon size={18} />
              </span>
              <span className={styles.linkText}>
                <span className={styles.linkLabel}>{link.label}</span>
                <span className={styles.linkHint}>{link.hint}</span>
              </span>
              <Chevron size={16} className={styles.linkChevron} />
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
