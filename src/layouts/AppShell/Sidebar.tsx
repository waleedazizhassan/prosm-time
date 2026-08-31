import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import { NAV_ITEMS } from "./navigation";
import BrandMark from "../../components/common/BrandMark";
import UserMenu from "./UserMenu";
import styles from "./Sidebar.module.css";

const FOCUSABLE_SELECTOR = 'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// PROSM Time - the application shell's left Sidebar navigation (§
// visual consistency pass: "left Sidebar navigation"). Same collapse-
// to-rail / mobile off-canvas drawer behavior as PROSM Platform's own
// Sidebar. §30: "users never see administrative navigation items for
// which they have no permission" - every item here is filtered by the
// real hasPermission() from AuthContext, which itself reflects
// get_prosm_time_effective_permissions() (§9); this list only decides
// what renders, every destination page re-enforces its own access
// independently (e.g. PeoplePage's own Navigate-away-if-unauthorized).
export default function Sidebar() {
  const { t } = useTranslation("shell");
  const { hasPermission } = useAuth();
  const { sidebarCollapsed, toggleSidebarCollapsed, mobileSidebarOpen, closeMobileSidebar } = useAppLayout();
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mobileSidebarOpen) return undefined;

    asideRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMobileSidebar();
        return;
      }

      if (event.key !== "Tab") return;

      const container = asideRef.current;
      if (!container) return;

      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileSidebarOpen, closeMobileSidebar]);

  const visibleItems = NAV_ITEMS.filter((item) => item.requiredPermission === null || hasPermission(item.requiredPermission));

  return (
    <>
      {mobileSidebarOpen ? <div className={styles.mobileBackdrop} onClick={closeMobileSidebar} aria-hidden="true" /> : null}

      <aside
        id="app-sidebar"
        ref={asideRef}
        tabIndex={-1}
        role={mobileSidebarOpen ? "dialog" : undefined}
        aria-modal={mobileSidebarOpen ? "true" : undefined}
        aria-label={mobileSidebarOpen ? t("navigationLabel") : undefined}
        className={[styles.sidebar, sidebarCollapsed ? styles.collapsed : "", mobileSidebarOpen ? styles.mobileOpen : ""].filter(Boolean).join(" ")}
      >
        <div className={styles.sidebarHeader}>
          <BrandMark size={24} />
          {!sidebarCollapsed ? <span className={styles.sidebarBrandName}>PROSM Time</span> : null}
        </div>

        <nav className={styles.navigation} aria-label={t("navigationLabel")}>
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={item.path}
                end
                className={({ isActive }) => [styles.item, isActive ? styles.active : ""].filter(Boolean).join(" ")}
                title={sidebarCollapsed ? t(item.labelKey) : undefined}
              >
                <span className={styles.itemIcon}>
                  <Icon size={18} strokeWidth={2} />
                </span>
                {!sidebarCollapsed ? <span className={styles.itemLabel}>{t(item.labelKey)}</span> : null}
              </NavLink>
            );
          })}
        </nav>

        <button
          type="button"
          className={styles.collapseButton}
          style={{ margin: "0 auto var(--space-2)" }}
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        <UserMenu collapsed={sidebarCollapsed} />
      </aside>
    </>
  );
}
