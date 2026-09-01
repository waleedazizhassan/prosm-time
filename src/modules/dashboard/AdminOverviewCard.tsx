import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { MapPin, Users, ClipboardList } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository from "../../core/repositories/SiteRepository";
import ManagerRepository from "../../core/repositories/ManagerRepository";
import Card from "../../components/common/Card";
import styles from "./AdminOverviewCard.module.css";

interface Kpi {
  icon: typeof MapPin;
  value: number;
  label: string;
}

// PROSM Time - § live UX review, user-directed: "my Dashboard looks
// like the employees' [Dashboard]... a KPI panel for sites, or
// anything professional." An Owner/Admin's Dashboard should read as
// visibly in-control, not identical to an individual contributor's -
// but per the same review's own constraint (no invented capabilities,
// no new backend), every number here is a real read from repositories
// that already exist and already power Manager Console/Sites - this
// is a compact rollup of that same real data, not a new domain
// concept. Gated on the same `attendance.view` permission Manager
// Console itself requires, so it only ever appears for someone who
// can already see this data on that page.
export default function AdminOverviewCard() {
  const { t } = useTranslation("dashboard");
  const { hasPermission } = useAuth();
  const canView = hasPermission("attendance.view");

  const [loading, setLoading] = useState(true);
  const [siteCount, setSiteCount] = useState<number | null>(null);
  const [clockedInCount, setClockedInCount] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [sitesResult, attendanceResult, pendingResult] = await Promise.all([
      SiteRepository.listSites(),
      ManagerRepository.listTodayAttendance(),
      ManagerRepository.listPendingReview(),
    ]);
    setSiteCount(sitesResult.success ? (sitesResult.data ?? []).length : null);
    setClockedInCount(attendanceResult.success ? (attendanceResult.data ?? []).filter((row) => row.status === "clocked_in").length : null);
    setPendingCount(pendingResult.success ? (pendingResult.data ?? []).length : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  if (!canView || loading) return null;

  const kpis: Kpi[] = [
    { icon: MapPin, value: siteCount ?? 0, label: t("overview.sites") },
    { icon: Users, value: clockedInCount ?? 0, label: t("overview.clockedInNow") },
    { icon: ClipboardList, value: pendingCount ?? 0, label: t("overview.pendingReviews") },
  ];

  return (
    <Card>
      <div className={styles.header}>
        <span className={styles.eyebrow}>{t("overview.title")}</span>
        <Link to="/manager" className={styles.link}>
          {t("overview.openManagerAction")}
        </Link>
      </div>
      <div className={styles.grid}>
        {kpis.map((kpi) => (
          <div key={kpi.label} className={styles.tile}>
            <kpi.icon size={16} className={styles.tileIcon} />
            <span className={styles.tileValue}>{kpi.value}</span>
            <span className={styles.tileLabel}>{kpi.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
