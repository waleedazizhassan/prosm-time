import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import { NAV_ITEMS, NAV_SECTION_ORDER } from "./navigation";
import UserMenu from "./UserMenu";
import SidebarRadio from "./SidebarRadio";
import { APP_VERSION } from "../../core/appVersion";
import styles from "./Sidebar.module.css";

const OPEN_SECTIONS_KEY = "prosm_time_sidebar_open_v1";
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
  const { t } = useTranslation(["shell", "common"]);
  const { hasPermission, profile } = useAuth();
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

  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      (item.requiredPermission === null || hasPermission(item.requiredPermission)) &&
      (!item.ownerOnly || profile?.isOwner) &&
      (!item.hiddenFromOwner || !profile?.isOwner) &&
      (!item.ownerOrManagerOnly || profile?.isOwner || profile?.roleKey === "manager")
  );
  // § live UX review, user-directed - group the same flat item list
  // under labeled sections (reference "Menu" screen's own grouping),
  // nothing new introduced - a section with no visible items (every
  // item in it permission-gated away) simply renders no heading.
  const sections = NAV_SECTION_ORDER.map((section) => ({ section, items: visibleItems.filter((item) => item.section === section) })).filter((group) => group.items.length > 0);

  // Which tree branches the person opened or closed (remembered on this device).
  const location = useLocation();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggleSection = (section: string, open: boolean) => {
    setOpenSections((current) => {
      const next = { ...current, [section]: open };
      try {
        localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable - the tree still works for this visit
      }
      return next;
    });
  };

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
          <div className={styles.sidebarBrand}>
            {/* § live UX review, user-directed - remove the logo mark
                from the Sidebar entirely, keep only the "PROSM" text.
                Always visible (even collapsed) since there is no icon
                left to represent the brand in the rail. */}
            <span className={styles.sidebarBrandName}>{t("common:appNameShort")}</span>
          </div>

          <button
            type="button"
            className={styles.collapseButton}
            // § live UX review, user-directed - on the mobile drawer,
            // this same chevron used to collapse it to a useless
            // icon-only rail that still ate screen space; a drawer that
            // never overlays a fixed rail should just close outright.
            // Desktop keeps the real collapse-to-rail behavior.
            onClick={mobileSidebarOpen ? closeMobileSidebar : toggleSidebarCollapsed}
            aria-label={mobileSidebarOpen ? t("closeSidebar") : sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className={styles.navigation} aria-label={t("navigationLabel")}>
          {sections.map((group) => {
            const renderItem = (item: (typeof group.items)[number]) => {
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
            };
            // The rail, and a group of one, show the items themselves.
            if (sidebarCollapsed || group.items.length === 1) {
              return (
                <div key={group.section} className={styles.navSection}>
                  {group.items.map(renderItem)}
                </div>
              );
            }
            // Owner 2026-10-20: a tree - each group opens and closes; the one holding the current page opens itself.
            const holdsCurrent = group.items.some((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
            const open = openSections[group.section] ?? holdsCurrent;
            return (
              <div key={group.section} className={styles.navSection}>
                <button type="button" className={[styles.branch, holdsCurrent ? styles.branchCurrent : ""].filter(Boolean).join(" ")} aria-expanded={open} onClick={() => toggleSection(group.section, !open)}>
                  <ChevronDown size={14} className={[styles.branchChevron, open ? styles.branchChevronOpen : ""].filter(Boolean).join(" ")} />
                  <span>{t(`sections.${group.section}`)}</span>
                  <span className={styles.branchCount}>{group.items.length}</span>
                </button>
                {open ? <div className={styles.branchItems}>{group.items.map(renderItem)}</div> : null}
              </div>
            );
          })}
        </nav>

        {/* § live UX review, user-directed - "on mobile, take the
            radio out of the header entirely and put it in the sidebar
            under a Media heading" - CSS-hidden at desktop widths
            (Sidebar.module.css), mirroring HeaderRadio's own inverse
            hiding on mobile (HeaderRadio.module.css). */}
        <div className={styles.mobileRadioSlot}>
          <SidebarRadio />
        </div>

        <UserMenu collapsed={sidebarCollapsed} />
        <p className={styles.versionLabel}>{t("common:versionLabel", { version: APP_VERSION })}</p>
      </aside>
    </>
  );
}
