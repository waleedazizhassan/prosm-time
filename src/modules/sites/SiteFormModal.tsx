import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import SiteRepository, { type Site, type KioskMode } from "../../core/repositories/SiteRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import { getCurrentPosition, haversineDistanceMeters } from "../../core/utils/geo";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";

interface SiteFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  site?: Site;
}

const KIOSK_MODE_OPTIONS: KioskMode[] = ["personal_device_only", "kiosk_only", "both_allowed"];

const toggleRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "var(--space-2) 0",
} as const;

// PROSM Time WP-05/§13 - site identity, location and core capability
// only: name, address, coordinates, allowed radius, time zone, kiosk
// mode, attendance/geofence/camera toggles, active status. Reused for
// both create and edit - the parent mounts this with
// `key={site?.id ?? "create"}` so state resets cleanly when switching
// between them. Every save is the real RPC (create/update_prosm_time_
// site) which re-checks 'sites.manage' server-side.
//
// § live UX review, user-directed - "Site Policy" (GPS accuracy
// tolerance, grace period, shift hours/overtime/late-deduction, break
// rounding, both self-service block toggles, exempt employees, and
// ongoing presence monitoring) moved entirely to its own Settings hub
// (SitePolicySettingsCard, a site picked from a dropdown) - none of
// that is collected or editable here anymore.
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function SiteFormModal({ isOpen, onClose, onSaved, site }: SiteFormModalProps) {
  const { t } = useTranslation("sites");
  const isEditing = Boolean(site);

  const [name, setName] = useState(site?.name ?? "");
  const [displayAddress, setDisplayAddress] = useState(site?.displayAddress ?? "");
  const [latitude, setLatitude] = useState(site ? String(site.latitude) : "");
  const [longitude, setLongitude] = useState(site ? String(site.longitude) : "");
  const [allowedRadiusMeters, setAllowedRadiusMeters] = useState(site ? String(site.allowedRadiusMeters) : "100");
  // A new site starts in the device's own time zone (it was UTC, which put
  // shift times hours off in Egypt).
  const [timezone, setTimezone] = useState(site?.timezone ?? deviceTimeZone());
  const [kioskMode, setKioskMode] = useState<KioskMode>(site?.kioskMode ?? "personal_device_only");
  const [attendanceAllowed, setAttendanceAllowed] = useState(site?.attendanceAllowed ?? true);
  const [geofenceRequired, setGeofenceRequired] = useState(site?.geofenceRequired ?? true);
  const [cameraRequired, setCameraRequired] = useState(site?.cameraRequired ?? false);
  const [isActive, setIsActive] = useState(site?.isActive ?? true);

  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [testResult, setTestResult] = useState<{ distanceMeters: number; within: boolean } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Not an editable field here - only used to make "Test this
  // location" show a realistic combined radius. Editing (site policy)
  // has its own real home in Settings. When creating a brand-new
  // site, this previews the organization's own current default rather
  // than a stale/hardcoded guess.
  const [gpsAccuracyToleranceMeters, setGpsAccuracyToleranceMeters] = useState(site ? site.gpsAccuracyToleranceMeters : 50);

  useEffect(() => {
    if (isEditing) return;
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setGpsAccuracyToleranceMeters(result.data.defaultGpsAccuracyToleranceMeters);
    });
  }, [isEditing]);

  const handleUseCurrentLocation = async () => {
    setLocating(true);
    setLocationError("");
    try {
      const position = await getCurrentPosition();
      setLatitude(String(position.latitude));
      setLongitude(String(position.longitude));
    } catch (geoError) {
      setLocationError(geoError instanceof Error ? geoError.message : t("form.locationError"));
    } finally {
      setLocating(false);
    }
  };

  const handleTestLocation = async () => {
    setLocating(true);
    setLocationError("");
    setTestResult(null);
    try {
      const position = await getCurrentPosition();
      const siteLat = Number(latitude);
      const siteLng = Number(longitude);
      const distanceMeters = haversineDistanceMeters(position.latitude, position.longitude, siteLat, siteLng);
      const radius = Number(allowedRadiusMeters) + gpsAccuracyToleranceMeters;
      setTestResult({ distanceMeters, within: distanceMeters <= radius });
    } catch (geoError) {
      setLocationError(geoError instanceof Error ? geoError.message : t("form.locationError"));
    } finally {
      setLocating(false);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");

    const input = {
      name: name.trim(),
      displayAddress: displayAddress.trim() || null,
      latitude: Number(latitude),
      longitude: Number(longitude),
      allowedRadiusMeters: Number(allowedRadiusMeters),
      timezone: timezone.trim(),
      attendanceAllowed,
      geofenceRequired,
      cameraRequired,
      kioskMode,
    };

    const result = isEditing && site ? await SiteRepository.updateSite(site.id, { ...input, isActive }) : await SiteRepository.createSite(input);

    setSubmitting(false);

    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("form.genericError"));
      return;
    }

    onSaved();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? t("form.editTitle") : t("form.createTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {t("form.confirm")}
          </Button>
        </>
      }
    >
      {/* Owner 2026-10-19 (simpler site setup): the essentials first - name,
          the location (stand at the site and use the phone's position), the
          radius and the photo; everything else under "More options". */}
      <Input label={t("form.nameLabel")} name="siteName" value={name} onChange={(event) => setName(event.target.value)} required disabled={submitting} />

      <div style={{ marginBottom: "var(--space-3)" }}>
        <span style={{ display: "block", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)", color: "var(--text-primary)", marginBottom: 6 }}>{t("form.locationLabel")}</span>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
          <Button type="button" size="sm" onClick={handleUseCurrentLocation} loading={locating} disabled={submitting}>
            {t("form.useCurrentLocationAction")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={handleTestLocation} loading={locating} disabled={submitting || !latitude || !longitude}>
            {t("form.testLocationAction")}
          </Button>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: "var(--font-xs)", color: latitude && longitude ? "var(--status-success-text)" : "var(--text-secondary)" }}>
          {latitude && longitude ? t("form.locationSet", { latitude: Number(latitude).toFixed(5), longitude: Number(longitude).toFixed(5) }) : t("form.locationHint")}
        </p>
      </div>

      <ErrorText>{locationError}</ErrorText>
      {testResult ? (
        <p style={{ color: testResult.within ? "var(--status-success-text)" : "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>
          {t(testResult.within ? "form.testLocationResultWithin" : "form.testLocationResultOutside", {
            distance: Math.round(testResult.distanceMeters),
            radius: Number(allowedRadiusMeters) + gpsAccuracyToleranceMeters,
          })}
        </p>
      ) : null}

      <Input
        label={t("form.allowedRadiusLabel")}
        name="siteAllowedRadius"
        type="number"
        value={allowedRadiusMeters}
        onChange={(event) => setAllowedRadiusMeters(event.target.value)}
        required
        disabled={submitting}
      />

      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.cameraRequiredLabel")}</span>
        <Toggle checked={cameraRequired} onChange={setCameraRequired} disabled={submitting} label={t("form.cameraRequiredLabel")} />
      </div>

      <details style={{ marginTop: "var(--space-3)" }}>
        <summary style={{ cursor: "pointer", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-link)", padding: "var(--space-2) 0" }}>{t("form.moreOptions")}</summary>

        <Input
          label={t("form.displayAddressLabel")}
          name="siteDisplayAddress"
          value={displayAddress}
          onChange={(event) => setDisplayAddress(event.target.value)}
          disabled={submitting}
          helperText={t("form.displayAddressHint")}
        />

        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <Input label={t("form.latitudeLabel")} name="siteLatitude" type="number" value={latitude} onChange={(event) => setLatitude(event.target.value)} required disabled={submitting} />
          <Input label={t("form.longitudeLabel")} name="siteLongitude" type="number" value={longitude} onChange={(event) => setLongitude(event.target.value)} required disabled={submitting} />
        </div>

        <Input label={t("form.timezoneLabel")} name="siteTimezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} required disabled={submitting} helperText={t("form.timezoneHint")} />

        <Select
          label={t("form.kioskModeLabel")}
          name="siteKioskMode"
          value={kioskMode}
          onChange={(event) => setKioskMode(event.target.value as KioskMode)}
          disabled={submitting}
          options={KIOSK_MODE_OPTIONS.map((mode) => ({ value: mode, label: t(`kioskMode.${mode}`) }))}
        />

        <div style={toggleRowStyle}>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.attendanceAllowedLabel")}</span>
          <Toggle checked={attendanceAllowed} onChange={setAttendanceAllowed} disabled={submitting} label={t("form.attendanceAllowedLabel")} />
        </div>
        <div style={toggleRowStyle}>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.geofenceRequiredLabel")}</span>
          <Toggle checked={geofenceRequired} onChange={setGeofenceRequired} disabled={submitting} label={t("form.geofenceRequiredLabel")} />
        </div>
        {isEditing ? (
          <div style={toggleRowStyle}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.activeLabel")}</span>
            <Toggle checked={isActive} onChange={setIsActive} disabled={submitting} label={t("form.activeLabel")} />
          </div>
        ) : null}
      </details>

      {isEditing && site ? (
        <p style={{ margin: "var(--space-3) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
          {t("form.sitePolicyMovedHint")}{" "}
          {/* The site's working rules are on the Settings page (owner 2026-10-20). */}
          <Link to={`/settings?site=${site.id}`} onClick={onClose} style={{ color: "var(--text-link)" }}>
            {t("form.openSiteSettings")}
          </Link>
        </p>
      ) : null}

      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
