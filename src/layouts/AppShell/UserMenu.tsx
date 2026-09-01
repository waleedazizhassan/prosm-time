import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import { useTheme, type ThemeMode } from "../../core/context/ThemeContext";
import { LANGUAGES } from "../../i18n/languages";
import sidebarStyles from "./Sidebar.module.css";
import styles from "./UserMenu.module.css";

const PANEL_GAP = 8;
const PANEL_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

// PROSM Time - the shell's User Menu, anchored at the Sidebar's own
// footer (matching PROSM Platform's own current placement -
// SidebarUserProfile, moved there from the Header per that codebase's
// own "UI improvement plan item 6" - not the Header). Shows the real,
// server-verified identity (§9) - name/email/role from AuthContext's
// profile, never a client-invented display. Deliberately narrower than
// PROSM Platform's own UserWorkspacePanel (no Settings/Appearance/
// Delegation sections) - this product has no equivalent screens yet;
// Sign out is the one real action that exists today.
//
// § live UX review bug fix, confirmed from a second screenshot after
// the panel-width fix: the language/theme selects finally showed real
// text, but the identity block still read as cut off. Root cause:
// `.sidebar` sets `overflow-y: auto` (needed for its own long nav-item
// list to scroll), and per the CSS spec, setting one overflow axis to
// anything but `visible` computes the OTHER axis to `auto` too if it
// was left at its default - so `.sidebar` was implicitly clipping
// horizontal overflow the whole time. This panel wasn't portaled out
// of that ancestor (unlike WeatherMiniPanel/HeaderRadio/
// HeaderOrganizationCard, which all already escape via
// createPortal(..., document.body) for exactly this reason), so a wide
// flyout meant to extend past the Sidebar's own edge was silently
// truncated at that edge. Fixed by portaling this panel too, matching
// the same positioning pattern already used by those three components.
export default function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { t, i18n } = useTranslation("shell");
  const { profile, signOut } = useAuth();
  const { userMenuOpen, toggleUserMenu, closeUserMenu } = useAppLayout();
  const { theme, setTheme } = useTheme();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useEffect(() => {
    if (!userMenuOpen) return undefined;

    function handleClickOutside(event: MouseEvent) {
      const clickedTrigger = triggerRef.current?.contains(event.target as Node);
      const clickedPanel = panelRef.current?.contains(event.target as Node);
      if (!clickedTrigger && !clickedPanel) closeUserMenu();
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeUserMenu();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [userMenuOpen, closeUserMenu]);

  useLayoutEffect(() => {
    if (!userMenuOpen) {
      setPanelStyle(null);
      return undefined;
    }

    const computePosition = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      const panelEl = panelRef.current;
      if (!triggerRect || !panelEl) return;

      const panelHeight = panelEl.offsetHeight;
      const top = Math.max(VIEWPORT_MARGIN, triggerRect.top - PANEL_GAP - panelHeight);

      const isRtl = document.documentElement.dir === "rtl";
      let left = isRtl ? triggerRect.right - PANEL_WIDTH : triggerRect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN));

      setPanelStyle({ top, left, maxHeight: window.innerHeight - VIEWPORT_MARGIN * 2 });
    };

    computePosition();
    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, true);
    return () => {
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
  }, [userMenuOpen]);

  const initial = profile?.fullName?.charAt(0)?.toUpperCase() ?? "?";

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className={sidebarStyles.userTrigger}
        onClick={toggleUserMenu}
        aria-haspopup="dialog"
        aria-expanded={userMenuOpen}
        aria-label={t("openUserMenu")}
      >
        <span className={sidebarStyles.triggerAvatar}>{initial}</span>
        {!collapsed ? (
          <>
            <span className={sidebarStyles.triggerName}>{profile?.fullName ?? ""}</span>
            <ChevronDown size={14} className={`${sidebarStyles.triggerChevron} ${userMenuOpen ? sidebarStyles.triggerChevronOpen : ""}`} />
          </>
        ) : null}
      </button>

      {userMenuOpen &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            role="dialog"
            style={{ top: panelStyle?.top ?? 0, left: panelStyle?.left ?? 0, maxHeight: panelStyle?.maxHeight, visibility: panelStyle ? "visible" : "hidden" }}
          >
            <div className={styles.identity}>
              <span className={styles.name}>{profile?.fullName}</span>
              <span className={styles.email}>{profile?.email}</span>
              <span className={styles.role}>{profile?.roleName}</span>
            </div>
            <label className={styles.languageLabel} htmlFor="userMenuLanguage">
              {t("languageLabel")}
            </label>
            <select id="userMenuLanguage" className={styles.languageSelect} value={i18n.language} onChange={(event) => i18n.changeLanguage(event.target.value)}>
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.nativeLabel}
                </option>
              ))}
            </select>
            <label className={styles.languageLabel} htmlFor="userMenuTheme">
              {t("themeLabel")}
            </label>
            <select id="userMenuTheme" className={styles.languageSelect} value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)}>
              <option value="dark">{t("theme.dark")}</option>
              <option value="light">{t("theme.light")}</option>
              <option value="system">{t("theme.system")}</option>
            </select>
            <button type="button" className={styles.signOutButton} onClick={signOut}>
              <LogOut size={16} />
              {t("signOutAction")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
