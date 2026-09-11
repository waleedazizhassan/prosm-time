import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut, Camera, Loader2 } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { useAppLayout } from "./LayoutContext";
import { useTheme, type ThemeMode } from "../../core/context/ThemeContext";
import { useCalendar, setCalendarSystem, type CalendarSystem } from "../../core/context/CalendarContext";
import { LANGUAGES } from "../../i18n/languages";
import UserRepository from "../../core/repositories/UserRepository";
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
  const { profile, signOut, refreshProfile } = useAuth();
  const { userMenuOpen, toggleUserMenu, closeUserMenu } = useAppLayout();
  const { theme, setTheme } = useTheme();
  const { calendarSystem } = useCalendar();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [panelStyle, setPanelStyle] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  // § live UX review, user-directed - "a place in the user menu to
  // upload a profile picture."
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  // § user-directed, 2026-09-12 - "the kiosk PIN must be chosen by the
  // employee themselves." set_prosm_time_kiosk_pin already existed
  // server-side with no frontend caller anywhere - this is that
  // missing self-service UI.
  const [kioskPin, setKioskPin] = useState("");
  const [kioskPinSaving, setKioskPinSaving] = useState(false);
  const [kioskPinMessage, setKioskPinMessage] = useState("");
  const [kioskPinError, setKioskPinError] = useState("");

  const handleSaveKioskPin = async () => {
    setKioskPinSaving(true);
    setKioskPinError("");
    setKioskPinMessage("");
    const result = await UserRepository.setKioskPin(kioskPin);
    setKioskPinSaving(false);
    if (!result.success) {
      setKioskPinError(result.message ?? t("kioskPinLabel"));
      return;
    }
    setKioskPin("");
    setKioskPinMessage(t("kioskPinSaved"));
  };

  const handleAvatarFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !profile) return;

    setAvatarUploading(true);
    setAvatarError("");
    const result = await UserRepository.uploadAvatar(profile.id, file);
    setAvatarUploading(false);

    if (!result.success) {
      setAvatarError(result.message ?? t("avatarUploadError"));
      return;
    }
    await refreshProfile();
  };

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
        <span className={sidebarStyles.triggerAvatar}>{profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : initial}</span>
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
              <button
                type="button"
                className={styles.avatarButton}
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                aria-label={t("changeAvatarAction")}
                title={t("changeAvatarAction")}
              >
                {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" className={styles.avatarImage} /> : <span className={styles.avatarInitial}>{initial}</span>}
                <span className={styles.avatarOverlay}>{avatarUploading ? <Loader2 size={14} className={styles.avatarSpinner} /> : <Camera size={14} />}</span>
              </button>
              <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleAvatarFileChange} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" />
              {avatarError ? <span className={styles.avatarError}>{avatarError}</span> : null}
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
            <label className={styles.languageLabel} htmlFor="userMenuKioskPin">
              {t("kioskPinLabel")}
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <input
                id="userMenuKioskPin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={kioskPin}
                onChange={(event) => setKioskPin(event.target.value.replace(/[^0-9]/g, ""))}
                className={styles.languageSelect}
                style={{ flex: 1 }}
                disabled={kioskPinSaving}
              />
              <button
                type="button"
                className={styles.signOutButton}
                style={{ width: "auto", padding: "0 var(--space-3)" }}
                onClick={handleSaveKioskPin}
                disabled={kioskPinSaving || kioskPin.length < 4}
              >
                {t("common:save")}
              </button>
            </div>
            {kioskPinError ? <span className={styles.avatarError}>{kioskPinError}</span> : null}
            {kioskPinMessage ? <span className={styles.email}>{kioskPinMessage}</span> : null}
            <label className={styles.languageLabel} htmlFor="userMenuCalendar">
              {t("calendarLabel")}
            </label>
            <select id="userMenuCalendar" className={styles.languageSelect} value={calendarSystem} onChange={(event) => setCalendarSystem(event.target.value as CalendarSystem)}>
              <option value="gregorian">{t("calendar.gregorian")}</option>
              <option value="hijri">{t("calendar.hijri")}</option>
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
