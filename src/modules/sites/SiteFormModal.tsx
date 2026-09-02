import { useState } from "react";
import { useTranslation } from "react-i18next";

import SiteRepository, { type Site, type KioskMode, type BreakRoundingMode } from "../../core/repositories/SiteRepository";
import { getCurrentPosition, haversineDistanceMeters } from "../../core/utils/geo";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import Toggle from "../../components/common/Toggle";

interface SiteFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  site?: Site;
}

const KIOSK_MODE_OPTIONS: KioskMode[] = ["personal_device_only", "kiosk_only", "both_allowed"];
const BREAK_ROUNDING_MODE_OPTIONS: BreakRoundingMode[] = ["cumulative", "full_hour"];

const toggleRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "var(--space-2) 0",
} as const;

// PROSM Time WP-05/§13 - "Site name, display address, latitude/
// longitude, allowed radius... GPS accuracy/tolerance policy...
// Time zone... Site policy... Map-based configuration and a test/
// verify function." Reused for both create and edit - the parent
// mounts this with `key={site?.id ?? "create"}` so state resets
// cleanly when switching between them. Every save is the real RPC
// (create/update_prosm_time_site) which re-checks 'sites.manage'
// server-side.
export default function SiteFormModal({ isOpen, onClose, onSaved, site }: SiteFormModalProps) {
  const { t } = useTranslation("sites");
  const isEditing = Boolean(site);

  const [name, setName] = useState(site?.name ?? "");
  const [displayAddress, setDisplayAddress] = useState(site?.displayAddress ?? "");
  const [latitude, setLatitude] = useState(site ? String(site.latitude) : "");
  const [longitude, setLongitude] = useState(site ? String(site.longitude) : "");
  const [allowedRadiusMeters, setAllowedRadiusMeters] = useState(site ? String(site.allowedRadiusMeters) : "100");
  const [gpsAccuracyToleranceMeters, setGpsAccuracyToleranceMeters] = useState(site ? String(site.gpsAccuracyToleranceMeters) : "50");
  const [timezone, setTimezone] = useState(site?.timezone ?? "UTC");
  const [graceToleranceMinutes, setGraceToleranceMinutes] = useState(site ? String(site.graceToleranceMinutes) : "5");
  const [kioskMode, setKioskMode] = useState<KioskMode>(site?.kioskMode ?? "personal_device_only");
  const [shiftStartTime, setShiftStartTime] = useState(site?.shiftStartTime ?? "");
  const [shiftEndTime, setShiftEndTime] = useState(site?.shiftEndTime ?? "");
  const [overtimeStartTime, setOvertimeStartTime] = useState(site?.overtimeStartTime ?? "");
  const [lateDeductionStartTime, setLateDeductionStartTime] = useState(site?.lateDeductionStartTime ?? "");
  const [breakRoundingMode, setBreakRoundingMode] = useState<BreakRoundingMode>(site?.breakRoundingMode ?? "cumulative");
  const [blockSelfClockInAfterGrace, setBlockSelfClockInAfterGrace] = useState(site?.blockSelfClockInAfterGrace ?? false);
  const [attendanceAllowed, setAttendanceAllowed] = useState(site?.attendanceAllowed ?? true);
  const [geofenceRequired, setGeofenceRequired] = useState(site?.geofenceRequired ?? true);
  const [cameraRequired, setCameraRequired] = useState(site?.cameraRequired ?? false);
  const [environmentalTagEnabled, setEnvironmentalTagEnabled] = useState(site?.environmentalTagEnabled ?? false);
  const [isActive, setIsActive] = useState(site?.isActive ?? true);

  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [testResult, setTestResult] = useState<{ distanceMeters: number; within: boolean } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
      const radius = Number(allowedRadiusMeters) + Number(gpsAccuracyToleranceMeters);
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
      gpsAccuracyToleranceMeters: Number(gpsAccuracyToleranceMeters),
      timezone: timezone.trim(),
      attendanceAllowed,
      geofenceRequired,
      cameraRequired,
      environmentalTagEnabled,
      kioskMode,
      graceToleranceMinutes: Number(graceToleranceMinutes),
      shiftStartTime: shiftStartTime || null,
      shiftEndTime: shiftEndTime || null,
      overtimeStartTime: overtimeStartTime || null,
      lateDeductionStartTime: lateDeductionStartTime || null,
      breakRoundingMode,
      blockSelfClockInAfterGrace,
    };

    const result = isEditing && site ? await SiteRepository.updateSite(site.id, { ...input, isActive }) : await SiteRepository.createSite(input);

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("form.genericError"));
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
      <Input label={t("form.nameLabel")} name="siteName" value={name} onChange={(event) => setName(event.target.value)} required disabled={submitting} />
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

      <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <Button type="button" variant="ghost" size="sm" onClick={handleUseCurrentLocation} loading={locating} disabled={submitting}>
          {t("form.useCurrentLocationAction")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleTestLocation} loading={locating} disabled={submitting || !latitude || !longitude}>
          {t("form.testLocationAction")}
        </Button>
      </div>

      {locationError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{locationError}</p> : null}
      {testResult ? (
        <p style={{ color: testResult.within ? "var(--status-success-text)" : "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>
          {t(testResult.within ? "form.testLocationResultWithin" : "form.testLocationResultOutside", {
            distance: Math.round(testResult.distanceMeters),
            radius: Number(allowedRadiusMeters) + Number(gpsAccuracyToleranceMeters),
          })}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Input
          label={t("form.allowedRadiusLabel")}
          name="siteAllowedRadius"
          type="number"
          value={allowedRadiusMeters}
          onChange={(event) => setAllowedRadiusMeters(event.target.value)}
          required
          disabled={submitting}
        />
        <Input
          label={t("form.gpsAccuracyToleranceLabel")}
          name="siteGpsAccuracyTolerance"
          type="number"
          value={gpsAccuracyToleranceMeters}
          onChange={(event) => setGpsAccuracyToleranceMeters(event.target.value)}
          required
          disabled={submitting}
        />
      </div>

      <Input label={t("form.timezoneLabel")} name="siteTimezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} required disabled={submitting} helperText={t("form.timezoneHint")} />

      <Input
        label={t("form.graceToleranceLabel")}
        name="siteGraceTolerance"
        type="number"
        value={graceToleranceMinutes}
        onChange={(event) => setGraceToleranceMinutes(event.target.value)}
        required
        disabled={submitting}
      />

      <Select
        label={t("form.kioskModeLabel")}
        name="siteKioskMode"
        value={kioskMode}
        onChange={(event) => setKioskMode(event.target.value as KioskMode)}
        disabled={submitting}
        options={KIOSK_MODE_OPTIONS.map((mode) => ({ value: mode, label: t(`kioskMode.${mode}`) }))}
      />

      {/* § live UX review, user-directed - per-site shift policy:
          work hours, when overtime/deduction start, break rounding,
          and whether a late self clock-in is blocked (manager-
          assisted only past that point). Every field here is
          optional - a site with none of them set behaves exactly as
          before this section existed. */}
      <h3 style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)", margin: "var(--space-4) 0 var(--space-1)" }}>
        {t("form.shiftPolicyTitle")}
      </h3>
      <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("form.shiftPolicyHint")}</p>

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Input label={t("form.shiftStartTimeLabel")} name="siteShiftStartTime" type="time" value={shiftStartTime} onChange={(event) => setShiftStartTime(event.target.value)} disabled={submitting} />
        <Input label={t("form.shiftEndTimeLabel")} name="siteShiftEndTime" type="time" value={shiftEndTime} onChange={(event) => setShiftEndTime(event.target.value)} disabled={submitting} />
      </div>

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Input
          label={t("form.overtimeStartTimeLabel")}
          name="siteOvertimeStartTime"
          type="time"
          value={overtimeStartTime}
          onChange={(event) => setOvertimeStartTime(event.target.value)}
          disabled={submitting}
        />
        <Input
          label={t("form.lateDeductionStartTimeLabel")}
          name="siteLateDeductionStartTime"
          type="time"
          value={lateDeductionStartTime}
          onChange={(event) => setLateDeductionStartTime(event.target.value)}
          disabled={submitting}
        />
      </div>

      <Select
        label={t("form.breakRoundingModeLabel")}
        name="siteBreakRoundingMode"
        value={breakRoundingMode}
        onChange={(event) => setBreakRoundingMode(event.target.value as BreakRoundingMode)}
        disabled={submitting}
        options={BREAK_ROUNDING_MODE_OPTIONS.map((mode) => ({ value: mode, label: t(`breakRoundingMode.${mode}`) }))}
      />

      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.blockSelfClockInLabel")}</span>
        <Toggle checked={blockSelfClockInAfterGrace} onChange={setBlockSelfClockInAfterGrace} disabled={submitting} label={t("form.blockSelfClockInLabel")} />
      </div>

      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.attendanceAllowedLabel")}</span>
        <Toggle checked={attendanceAllowed} onChange={setAttendanceAllowed} disabled={submitting} label={t("form.attendanceAllowedLabel")} />
      </div>
      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.geofenceRequiredLabel")}</span>
        <Toggle checked={geofenceRequired} onChange={setGeofenceRequired} disabled={submitting} label={t("form.geofenceRequiredLabel")} />
      </div>
      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.cameraRequiredLabel")}</span>
        <Toggle checked={cameraRequired} onChange={setCameraRequired} disabled={submitting} label={t("form.cameraRequiredLabel")} />
      </div>
      <div style={toggleRowStyle}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.environmentalTagLabel")}</span>
        <Toggle checked={environmentalTagEnabled} onChange={setEnvironmentalTagEnabled} disabled={submitting} label={t("form.environmentalTagLabel")} />
      </div>
      {isEditing ? (
        <div style={toggleRowStyle}>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("form.activeLabel")}</span>
          <Toggle checked={isActive} onChange={setIsActive} disabled={submitting} label={t("form.activeLabel")} />
        </div>
      ) : null}

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
    </Modal>
  );
}
