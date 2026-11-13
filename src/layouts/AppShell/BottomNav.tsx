import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { CalendarClock, CalendarDays, Clock, Home, IdCard, LayoutGrid, Menu, MessagesSquare, Users, Wallet, type LucideIcon } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures, { type PlanFeature } from "../../core/hooks/usePlanFeatures";
import { useAppLayout } from "./LayoutContext";
import useConnect from "../../modules/connect/useConnect";
import styles from "./BottomNav.module.css";

// The employee's bar (owner 2026-10-19); the phone menu lists every other page.
// the pages the employee's bar holds (the phone menu does not repeat them); review 2026-11-12: by plan
export function employeeBottomPaths(allows: (feature: PlanFeature) => boolean): string[] {
  return ["/dashboard", allows("allowances") ? "/allowances" : "/schedule"];
}

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
  const location = useLocation();
  const { allows } = usePlanFeatures(profile?.id);
  const connect = useConnect(profile?.id);
  if (!profile) return null;

  const manages = profile.isOwner || hasPermission("exceptions.manage");
  // Owner 2026-11-09: home in the middle of the bar
  const home: BottomItem = { to: "/dashboard", label: t("bottomNav.home"), icon: Home };
  // Owner 2026-11-13: with PROSM Connect, "Conversations" joins the bar (in place of the manager panel for those
  // who manage, of the allowances or shifts for the others - both stay in the menu)
  const chats: BottomItem | null = connect.on ? { to: "/connect", label: t("bottomNav.chats"), icon: MessagesSquare } : null;
  const items: BottomItem[] = chats
    ? manages
      ? [
          chats,
          ...(profile.isOwner || hasPermission("employees.view") ? [{ to: "/people", label: t("bottomNav.people"), icon: Users }] : []),
          home,
          { to: "/attendance", label: t("bottomNav.attendance"), icon: Clock },
        ]
      : [
          { to: "/me?tab=attendance", label: t("bottomNav.attendance"), icon: Clock },
          chats,
          home,
          allows("leave") ? { to: "/me?tab=leave", label: t("bottomNav.leave"), icon: CalendarDays } : { to: "/me", label: t("bottomNav.myFile"), icon: IdCard },
        ]
    : manages
    ? [
        { to: "/manager", label: t("bottomNav.manager"), icon: LayoutGrid },
        ...(profile.isOwner || hasPermission("employees.view") ? [{ to: "/people", label: t("bottomNav.people"), icon: Users }] : []),
        home,
        { to: "/attendance", label: t("bottomNav.attendance"), icon: Clock },
      ]
    : [
        // owner 2026-11-12: one's own attendance is in My file
        { to: "/me?tab=attendance", label: t("bottomNav.attendance"), icon: Clock },
        // review 2026-11-12: only what the plan includes - else the shifts and the person's own file
        allows("allowances") ? { to: "/allowances", label: t("bottomNav.allowances"), icon: Wallet } : { to: "/schedule", label: t("bottomNav.schedule"), icon: CalendarClock },
        home,
        allows("leave") ? { to: "/me?tab=leave", label: t("bottomNav.leave"), icon: CalendarDays } : { to: "/me", label: t("bottomNav.myFile"), icon: IdCard },
      ];
  // two buttons may open My file on different tabs: only the open tab's button is lit
  const sameTab = (to: string) => {
    const wanted = new URLSearchParams(to.split("?")[1] ?? "").get("tab");
    return !wanted || new URLSearchParams(location.search).get("tab") === wanted;
  };
  // on the home page already, home refreshes it and goes back to the top
  const onHome = (event: React.MouseEvent, to: string) => {
    if (to !== "/dashboard" || location.pathname !== "/dashboard") return;
    event.preventDefault();
    window.location.reload();
  };

  return (
    <nav className={styles.bar} aria-label={t("bottomNav.label")}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} onClick={(event) => onHome(event, item.to)} className={({ isActive }) => `${styles.item} ${isActive && sameTab(item.to) ? styles.active : ""} ${item.to === "/dashboard" ? styles.homeItem : ""}`}>
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
