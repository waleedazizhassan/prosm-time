import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { CalendarDays, Clock, Home, LayoutGrid, Menu, Users, Wallet, type LucideIcon } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import styles from "./BottomNav.module.css";

interface BottomItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// Owner 2026-10-19 (simpler app, ideas from the competitor's screens): on a
// phone the most used pages sit in a bar at the bottom - for an employee
// their home, attendance record, allowances and leave; for the Owner, a
// Manager or a Supervisor the dashboard, Manager Console, People and the
// attendance record - with Menu opening the full side menu.
export default function BottomNav() {
  const { t } = useTranslation("shell");
  const { profile, hasPermission } = useAuth();
  const { openMobileSidebar } = useAppLayout();
  if (!profile) return null;

  const manages = profile.isOwner || hasPermission("exceptions.manage");
  const items: BottomItem[] = manages
    ? [
        { to: "/dashboard", label: t("bottomNav.home"), icon: Home },
        { to: "/manager", label: t("bottomNav.manager"), icon: LayoutGrid },
        ...(profile.isOwner || hasPermission("employees.view") ? [{ to: "/people", label: t("bottomNav.people"), icon: Users }] : []),
        { to: "/attendance", label: t("bottomNav.attendance"), icon: Clock },
      ]
    : [
        { to: "/dashboard", label: t("bottomNav.home"), icon: Home },
        { to: "/attendance", label: t("bottomNav.attendance"), icon: Clock },
        { to: "/allowances", label: t("bottomNav.allowances"), icon: Wallet },
        { to: "/leave", label: t("bottomNav.leave"), icon: CalendarDays },
      ];

  return (
    <nav className={styles.bar} aria-label={t("bottomNav.label")}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ""}`}>
          <span className={styles.icon}>
            <item.icon size={22} />
          </span>
          <span className={styles.label}>{item.label}</span>
        </NavLink>
      ))}
      <button type="button" className={styles.item} onClick={openMobileSidebar}>
        <span className={styles.icon}>
          <Menu size={22} />
        </span>
        <span className={styles.label}>{t("bottomNav.menu")}</span>
      </button>
    </nav>
  );
}
