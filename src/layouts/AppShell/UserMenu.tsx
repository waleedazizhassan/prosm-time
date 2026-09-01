import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import { LANGUAGES } from "../../i18n/languages";
import sidebarStyles from "./Sidebar.module.css";
import styles from "./UserMenu.module.css";

// PROSM Time - the shell's User Menu, anchored at the Sidebar's own
// footer (matching PROSM Platform's own current placement -
// SidebarUserProfile, moved there from the Header per that codebase's
// own "UI improvement plan item 6" - not the Header). Shows the real,
// server-verified identity (§9) - name/email/role from AuthContext's
// profile, never a client-invented display. Deliberately narrower than
// PROSM Platform's own UserWorkspacePanel (no Settings/Appearance/
// Delegation sections) - this product has no equivalent screens yet;
// Sign out is the one real action that exists today.
export default function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { t, i18n } = useTranslation("shell");
  const { profile, signOut } = useAuth();
  const { userMenuOpen, toggleUserMenu, closeUserMenu } = useAppLayout();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!userMenuOpen) return undefined;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeUserMenu();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen, closeUserMenu]);

  const initial = profile?.fullName?.charAt(0)?.toUpperCase() ?? "?";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
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

      {userMenuOpen ? (
        <div className={styles.panel} role="dialog">
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
          <button type="button" className={styles.signOutButton} onClick={signOut}>
            <LogOut size={16} />
            {t("signOutAction")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
