import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw, Upload, Loader2 } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import OrganizationRepository, { type Organization } from "../../core/repositories/OrganizationRepository";
import LicenseRepository, { type LicenseState } from "../../core/repositories/LicenseRepository";
import StatusBadge from "../../components/common/StatusBadge";
import { formatDateOnly } from "../../core/utils/formatDate";
import styles from "./HeaderOrganizationCard.module.css";

const PANEL_GAP = 8;
const PANEL_WIDTH = 280;
const VIEWPORT_MARGIN = 8;
const HOVER_CLOSE_DELAY_MS = 150;

// Ported from PROSM Platform's own Header/OrganizationCard (§ final
// visual consistency pass, correction - "The large Organization and
// License & Plan cards currently displayed on the Dashboard are
// unnecessary... their important information can instead be
// represented as compact Header information, consistent with the
// PROSM Platform approach"). Same shape as Platform's own component: a
// small logo/initial trigger, a hover/click quick-look panel portaled
// to document.body. The one real capability this replaces - refreshing
// the cached license status - survives here as the panel's own
// refresh icon, not dropped.
function HeaderOrganizationCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ top: number; left: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePickerOpenRef = useRef(false);

  const load = useCallback(async () => {
    const [orgResult, licenseResult] = await Promise.all([OrganizationRepository.getCurrentOrganization(), LicenseRepository.getCurrentLicenseState()]);
    if (orgResult.success) setOrganization(orgResult.data);
    if (licenseResult.success) setLicense(licenseResult.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const isRtl = document.documentElement.dir === "rtl";
    let left = isRtl ? rect.right - PANEL_WIDTH : rect.left;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN));
    setPanelPosition({ top: rect.bottom + PANEL_GAP, left });
  };

  const cancelScheduledClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // § live UX review, user-directed - "the flyout closes the instant I
  // move the mouse off the button, before I can reach it." Root cause:
  // the portaled panel lives outside containerRef's own DOM subtree
  // (createPortal to document.body, § WeatherMiniPanel's own comment),
  // so onMouseLeave fired the moment the cursor left the trigger's
  // bounding box, before ever reaching the panel below it. Fixed with
  // the exact same pattern WeatherMiniPanel already uses for this same
  // problem: a short debounced close (cancelled if the cursor re-enters
  // either the trigger or the panel itself) instead of an instant one.
  const openPanel = () => {
    cancelScheduledClose();
    updatePosition();
    setPanelOpen(true);
  };

  const closePanel = () => setPanelOpen(false);

  // § live UX review, user-directed - "the button works but the logo
  // itself never uploads." Root cause found by querying the live
  // storage bucket directly: it was empty, meaning the upload never
  // even started. The native OS file picker opened by
  // logoInputRef.current.click() takes the OS window away from the
  // browser - the cursor leaves the panel the instant that happens,
  // which (even with the hover-close fix above) still schedules a
  // close; by the time the user has picked a file and the OS dialog
  // closes, the timer has long since fired and unmounted the portaled
  // panel - taking the very <input> the OS dialog was about to report
  // back to with it, so the file selection had nowhere to land.
  // filePickerOpenRef suspends the hover-close entirely for the
  // duration of the picker being open.
  const scheduleClosePanel = () => {
    if (filePickerOpenRef.current) return;
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setPanelOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  useEffect(() => {
    if (!panelOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      const clickedTrigger = containerRef.current?.contains(event.target as Node);
      const clickedPanel = panelRef.current?.contains(event.target as Node);
      if (!clickedTrigger && !clickedPanel) closePanel();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [panelOpen]);

  useEffect(() => cancelScheduledClose, []);

  const handleRefresh = async (event: ReactMouseEvent) => {
    event.stopPropagation();
    setRefreshing(true);
    await LicenseRepository.refreshCurrentLicenseStatus();
    await load();
    setRefreshing(false);
  };

  // § live UX review, user-directed - "a place to upload the company
  // logo so it shows in the organization data in the Header." Owner-
  // only (the RPC re-checks this server-side regardless), reachable
  // from here since it works for any already-activated organization
  // immediately, not only at the one-time Activation moment.
  const handleLogoButtonClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    cancelScheduledClose();
    filePickerOpenRef.current = true;
    // The OS file picker is its own window - there is no reliable
    // "picker closed" DOM event, so window focus returning (fires
    // whether a file was chosen or the dialog was cancelled) is the
    // one signal that reliably means the picker is gone.
    const clearFilePickerFlag = () => {
      filePickerOpenRef.current = false;
      window.removeEventListener("focus", clearFilePickerFlag);
    };
    window.addEventListener("focus", clearFilePickerFlag, { once: true });
    logoInputRef.current?.click();
  };

  const handleLogoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    filePickerOpenRef.current = false;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !organization) return;

    setUploadingLogo(true);
    setLogoError("");
    const result = await OrganizationRepository.uploadLogo(organization.id, file);
    setUploadingLogo(false);

    if (!result.success) {
      setLogoError(result.message ?? t("organizationCard.logoUploadError"));
      return;
    }
    await load();
  };

  if (!organization) return null;

  const initial = organization.name.charAt(0).toUpperCase();

  return (
    <div ref={containerRef} className={styles.container} onMouseEnter={openPanel} onMouseLeave={scheduleClosePanel}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => (panelOpen ? closePanel() : openPanel())}
        aria-haspopup="true"
        aria-expanded={panelOpen}
        aria-label={organization.name}
        title={organization.name}
      >
        {organization.logoUrl ? <img src={organization.logoUrl} alt={organization.name} className={styles.logoImage} /> : <span className={styles.logo}>{initial}</span>}
      </button>

      {panelOpen &&
        panelPosition &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            style={{ top: panelPosition.top, left: panelPosition.left }}
            role="dialog"
            aria-label={organization.name}
            onMouseEnter={openPanel}
            onMouseLeave={scheduleClosePanel}
          >
            <div className={styles.panelHeader}>
              {organization.logoUrl ? <img src={organization.logoUrl} alt={organization.name} className={styles.panelLogoImage} /> : <span className={styles.panelLogo}>{initial}</span>}
              <div className={styles.panelName}>{organization.name}</div>
              <button type="button" className={styles.refreshButton} onClick={handleRefresh} aria-label={t("licenseCard.refreshAction")} title={t("licenseCard.refreshAction")}>
                <RefreshCw size={13} className={refreshing ? styles.spinning : undefined} />
              </button>
            </div>

            <div className={styles.panelRow}>
              <span className={styles.panelLabel}>{t("organizationCard.codeLabel")}</span>
              <span className={styles.panelValue}>{organization.organizationCode}</span>
            </div>
            <div className={styles.panelRow}>
              <span className={styles.panelLabel}>{t("organizationCard.statusLabel")}</span>
              <StatusBadge status={organization.status}>{organization.status}</StatusBadge>
            </div>

            {profile?.isOwner ? (
              <>
                {logoError ? <p className={styles.logoError}>{logoError}</p> : null}
                <button type="button" className={styles.logoUploadButton} onClick={handleLogoButtonClick} disabled={uploadingLogo}>
                  {uploadingLogo ? <Loader2 size={13} className={styles.spinning} /> : <Upload size={13} />}
                  {organization.logoUrl ? t("organizationCard.changeLogoAction") : t("organizationCard.uploadLogoAction")}
                </button>
                <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoFileChange} className={styles.hiddenInput} tabIndex={-1} aria-hidden="true" />
              </>
            ) : null}

            {license ? (
              <>
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>{t("licenseCard.licenseNumberLabel")}</span>
                  <span className={styles.panelValue}>{license.licenseNumber}</span>
                </div>
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>{t("licenseCard.statusLabel")}</span>
                  <StatusBadge status={license.status}>{t(`licenseCard.status.${license.status}`, { defaultValue: license.status })}</StatusBadge>
                </div>
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>{t("licenseCard.usersLabel")}</span>
                  <span className={styles.panelValue}>
                    {license.maxUsers ?? "—"} · {t("licenseCard.devicesLabel")}: {license.maxDevices ?? "—"}
                  </span>
                </div>
                <div className={styles.panelRow}>
                  <span className={styles.panelLabel}>{t("licenseCard.expiresLabel")}</span>
                  <span className={styles.panelValue}>{license.expiresAt ? formatDateOnly(license.expiresAt, i18n.language) : t("licenseCard.noExpiry")}</span>
                </div>
              </>
            ) : null}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default memo(HeaderOrganizationCard);
