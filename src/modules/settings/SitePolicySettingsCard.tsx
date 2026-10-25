import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../core/context/AuthContext";

import SiteRepository, { type Site, type SiteAssignment, type BreakRoundingMode, type OutsideZonePolicy } from "../../core/repositories/SiteRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

const BREAK_ROUNDING_MODE_OPTIONS: BreakRoundingMode[] = ["cumulative", "full_hour"];
const OUTSIDE_ZONE_POLICY_OPTIONS: OutsideZonePolicy[] = ["ALLOW_WITH_EXCEPTION", "BLOCK"];

const toggleRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "var(--space-2) 0",
} as const;

// PROSM Time - § live UX review, user-directed: "put shift policy and
// exempt employees in Settings too, next to a site picker in a
// dropdown - and same thing for GPS accuracy tolerance." A site's
// full behavioral policy - GPS tolerance, grace period, shift hours/
// overtime/late-deduction, break rounding, both self-service block
// toggles, exempt employees, and ongoing presence monitoring - now
// lives entirely here rather than in that site's own Edit form: pick
// a site, edit its policy, save.
// Identity/location/capability (name, address, coordinates, radius,
// time zone, kiosk mode, attendance/geofence/camera, active status)
// stay on the site's own Edit form - genuinely site-identity concerns
// rather than a behavioral policy knob.
// Owner 2026-10-20 (simpler settings): shown on the site's own page with
// `siteId` - no site picker; everything about a site in one place.
export default function SitePolicySettingsCard({ siteId }: { siteId?: string } = {}) {
  const { t } = useTranslation(["settings", "sites"]);

  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  // Audit 4.6 - the site form links here with ?site=<id>, already selected.
  const [searchParams] = useSearchParams();
  const [selectedSiteId, setSelectedSiteId] = useState(() => siteId ?? searchParams.get("site") ?? "");
  const [site, setSite] = useState<Site | null>(null);
  const [siteLoading, setSiteLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [gpsAccuracyToleranceMeters, setGpsAccuracyToleranceMeters] = useState("50");
  const [graceToleranceMinutes, setGraceToleranceMinutes] = useState("5");
  const [shiftStartTime, setShiftStartTime] = useState("");
  const [shiftEndTime, setShiftEndTime] = useState("");
  const [overtimeStartTime, setOvertimeStartTime] = useState("");
  const [lateDeductionStartTime, setLateDeductionStartTime] = useState("");
  const [breakRoundingMode, setBreakRoundingMode] = useState<BreakRoundingMode>("cumulative");
  const [blockSelfClockInAfterGrace, setBlockSelfClockInAfterGrace] = useState(false);
  const [outsideZonePolicy, setOutsideZonePolicy] = useState<OutsideZonePolicy>("ALLOW_WITH_EXCEPTION");
  const [presenceMonitoringEnabled, setPresenceMonitoringEnabled] = useState(false);

  const [assignments, setAssignments] = useState<SiteAssignment[]>([]);
  const [exemptionSavingUserId, setExemptionSavingUserId] = useState<string | null>(null);
  const [exemptionError, setExemptionError] = useState("");
  const [employeeToExempt, setEmployeeToExempt] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  // Owner 2026-10-20 ("every setting on the Settings page"): the picker lists the
  // sites the reader manages (the Owner: every site); the first is chosen.
  const { profile } = useAuth();
  const isOwner = Boolean(profile?.isOwner);
  const profileId = profile?.id;
  useEffect(() => {
    if (siteId) return;
    Promise.all([SiteRepository.listSites(), isOwner || !profileId ? Promise.resolve(null) : SiteRepository.listManagedSiteIds(profileId)]).then(([result, managed]) => {
      const managedIds = managed && managed.success ? new Set(managed.data ?? []) : null;
      const list = result.success && result.data ? result.data.filter((candidate) => !managedIds || managedIds.has(candidate.id)) : [];
      setSites(list);
      setSelectedSiteId((current) => current || list[0]?.id || "");
      setSitesLoading(false);
    });
  }, [siteId, isOwner, profileId]);

  useEffect(() => {
    if (!selectedSiteId) {
      setSite(null);
      setAssignments([]);
      return;
    }
    setSiteLoading(true);
    setLoadError("");
    setSaved(false);
    Promise.all([SiteRepository.getSite(selectedSiteId), SiteRepository.listSiteAssignments(selectedSiteId)]).then(([siteResult, assignmentsResult]) => {
      setSiteLoading(false);
      if (!siteResult.success || !siteResult.data) {
        setLoadError(humanizeBackendError(siteResult.message, t) ?? t("sitePolicy.loadError"));
        return;
      }
      const loaded = siteResult.data;
      setSite(loaded);
      setGpsAccuracyToleranceMeters(String(loaded.gpsAccuracyToleranceMeters));
      setGraceToleranceMinutes(String(loaded.graceToleranceMinutes));
      setShiftStartTime(loaded.shiftStartTime ?? "");
      setShiftEndTime(loaded.shiftEndTime ?? "");
      setOvertimeStartTime(loaded.overtimeStartTime ?? "");
      setLateDeductionStartTime(loaded.lateDeductionStartTime ?? "");
      setBreakRoundingMode(loaded.breakRoundingMode);
      setBlockSelfClockInAfterGrace(loaded.blockSelfClockInAfterGrace);
      setOutsideZonePolicy(loaded.outsideZonePolicy);
      setPresenceMonitoringEnabled(loaded.presenceMonitoringEnabled);
      setAssignments(assignmentsResult.success ? assignmentsResult.data ?? [] : []);
    });
  }, [selectedSiteId, t]);

  const handleToggleExemption = async (assignment: SiteAssignment, isExempt: boolean) => {
    if (!selectedSiteId) return;
    setExemptionSavingUserId(assignment.userId);
    setExemptionError("");
    const result = await SiteRepository.setSiteAssignmentExemption(selectedSiteId, assignment.userId, isExempt);
    setExemptionSavingUserId(null);
    if (!result.success) {
      setExemptionError(humanizeBackendError(result.message, t) ?? t("sites:form.genericError"));
      return;
    }
    setAssignments((current) => current.map((row) => (row.userId === assignment.userId ? { ...row, isExemptFromRestrictions: isExempt } : row)));
  };

  const exemptAssignments = assignments.filter((assignment) => assignment.isExemptFromRestrictions);
  const nonExemptAssignments = assignments.filter((assignment) => !assignment.isExemptFromRestrictions);

  const handleAddExemption = async () => {
    if (!employeeToExempt) return;
    const assignment = assignments.find((row) => row.userId === employeeToExempt);
    if (!assignment) return;
    await handleToggleExemption(assignment, true);
    setEmployeeToExempt("");
  };

  const handleSave = async () => {
    if (!selectedSiteId) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);

    const result = await SiteRepository.updateSite(selectedSiteId, {
      gpsAccuracyToleranceMeters: Number(gpsAccuracyToleranceMeters),
      graceToleranceMinutes: Number(graceToleranceMinutes),
      shiftStartTime: shiftStartTime || null,
      shiftEndTime: shiftEndTime || null,
      overtimeStartTime: overtimeStartTime || null,
      lateDeductionStartTime: lateDeductionStartTime || null,
      breakRoundingMode,
      blockSelfClockInAfterGrace,
      blockSelfClockOutOutsideGeofence: false,
      presenceMonitoringEnabled,
    });
    // Audit 2.1 / v2.3.43 step 1 - its own call (audited), same authority as the site update.
    const clockInResult =
      result.success && site && site.outsideZonePolicy !== outsideZonePolicy ? await SiteRepository.setOutsideZonePolicy(selectedSiteId, outsideZonePolicy) : result;

    setSaving(false);
    if (!clockInResult.success) {
      setSaveError(humanizeBackendError(clockInResult.message, t) ?? t("sitePolicy.genericError"));
      return;
    }
    setSite((current) => (current ? { ...current, outsideZonePolicy } : current));
    setSaved(true);
  };

  return (
    <Card title={t("sitePolicy.title")}>
      <HintText>{t("sitePolicy.hint")}</HintText>

      {siteId ? null : (
      <div style={{ maxWidth: 320 }}>
        <Select
          label={t("sitePolicy.siteSelectLabel")}
          name="sitePolicySiteId"
          value={selectedSiteId}
          onChange={(event) => setSelectedSiteId(event.target.value)}
          disabled={sitesLoading}
          options={[{ value: "", label: t("sitePolicy.siteSelectPlaceholder") }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>
      )}

      {!siteId && !sitesLoading && sites.length === 0 ? <HintText>{t("sitePolicy.noSites")}</HintText> : null}

      <ErrorText>{loadError}</ErrorText>

      {siteLoading ? null : site ? (
        <>
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
            <div style={{ maxWidth: 220 }}>
              <Input
                label={t("sites:form.gpsAccuracyToleranceLabel")}
                name="policyGpsAccuracyTolerance"
                type="number"
                value={gpsAccuracyToleranceMeters}
                onChange={(event) => {
                  setGpsAccuracyToleranceMeters(event.target.value);
                  setSaved(false);
                }}
                disabled={saving}
              />
            </div>
            <div style={{ maxWidth: 220 }}>
              <Input
                label={t("sites:form.graceToleranceLabel")}
                name="policyGraceTolerance"
                type="number"
                value={graceToleranceMinutes}
                onChange={(event) => {
                  setGraceToleranceMinutes(event.target.value);
                  setSaved(false);
                }}
                disabled={saving}
              />
            </div>
          </div>

          <h3 style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)", margin: "var(--space-4) 0 var(--space-1)" }}>
            {t("sites:form.shiftPolicyTitle")}
          </h3>
          <HintText small>{t("sites:form.shiftPolicyHint")}</HintText>

          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <Input
              label={t("sites:form.shiftStartTimeLabel")}
              name="policyShiftStartTime"
              type="time"
              value={shiftStartTime}
              onChange={(event) => {
                setShiftStartTime(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
            />
            <Input
              label={t("sites:form.shiftEndTimeLabel")}
              name="policyShiftEndTime"
              type="time"
              value={shiftEndTime}
              onChange={(event) => {
                setShiftEndTime(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
            />
          </div>

          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <Input
              label={t("sites:form.overtimeStartTimeLabel")}
              name="policyOvertimeStartTime"
              type="time"
              value={overtimeStartTime}
              onChange={(event) => {
                setOvertimeStartTime(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
            />
            <Input
              label={t("sites:form.lateDeductionStartTimeLabel")}
              name="policyLateDeductionStartTime"
              type="time"
              value={lateDeductionStartTime}
              onChange={(event) => {
                setLateDeductionStartTime(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
            />
          </div>

          <Select
            label={t("sites:form.breakRoundingModeLabel")}
            name="policyBreakRoundingMode"
            value={breakRoundingMode}
            onChange={(event) => {
              setBreakRoundingMode(event.target.value as BreakRoundingMode);
              setSaved(false);
            }}
            disabled={saving}
            options={BREAK_ROUNDING_MODE_OPTIONS.map((mode) => ({ value: mode, label: t(`sites:breakRoundingMode.${mode}`) }))}
          />

          <div style={toggleRowStyle}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("sites:form.blockSelfClockInLabel")}</span>
            <Toggle
              checked={blockSelfClockInAfterGrace}
              onChange={(checked) => {
                setBlockSelfClockInAfterGrace(checked);
                setSaved(false);
              }}
              disabled={saving}
              label={t("sites:form.blockSelfClockInLabel")}
            />
          </div>
          <Select
            label={t("sites:form.outsideZonePolicyLabel")}
            name="policyOutsideZone"
            value={outsideZonePolicy}
            onChange={(event) => {
              setOutsideZonePolicy(event.target.value as OutsideZonePolicy);
              setSaved(false);
            }}
            disabled={saving}
            options={OUTSIDE_ZONE_POLICY_OPTIONS.map((policy) => ({ value: policy, label: t(`sites:outsideZonePolicy.${policy}`) }))}
          />
          <HintText small>{t("sites:form.clockOutOutsideNote")}</HintText>
          <div style={toggleRowStyle}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("sites:form.presenceMonitoringEnabledLabel")}</span>
            <Toggle
              checked={presenceMonitoringEnabled}
              onChange={(checked) => {
                setPresenceMonitoringEnabled(checked);
                setSaved(false);
              }}
              disabled={saving}
              label={t("sites:form.presenceMonitoringEnabledLabel")}
            />
          </div>
          <HintText small>{t("sites:form.presenceMonitoringEnabledHint")}</HintText>

          {assignments.length > 0 ? (
            <div style={{ margin: "var(--space-3) 0" }}>
              <h3 style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)", margin: "0 0 var(--space-1)" }}>
                {t("sites:form.exemptEmployeesTitle")}
              </h3>
              <HintText small>{t("sites:form.exemptEmployeesHint")}</HintText>

              {nonExemptAssignments.length > 0 ? (
                <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label={t("sites:form.exemptEmployeesAddLabel")}
                      name="policyEmployeeToExempt"
                      value={employeeToExempt}
                      onChange={(event) => setEmployeeToExempt(event.target.value)}
                      disabled={exemptionSavingUserId !== null}
                      options={[
                        { value: "", label: t("sites:form.exemptEmployeesSelectPlaceholder") },
                        ...nonExemptAssignments.map((assignment) => ({ value: assignment.userId, label: assignment.userFullName })),
                      ]}
                    />
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={handleAddExemption} disabled={!employeeToExempt || exemptionSavingUserId !== null} style={{ marginBottom: "var(--space-4)" }}>
                    {t("sites:form.exemptEmployeesAddAction")}
                  </Button>
                </div>
              ) : null}

              {exemptAssignments.length > 0 ? (
                <ul style={{ listStyle: "none", margin: "var(--space-2) 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  {exemptAssignments.map((assignment) => (
                    <li key={assignment.id} style={toggleRowStyle}>
                      <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{assignment.userFullName}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => handleToggleExemption(assignment, false)} disabled={exemptionSavingUserId === assignment.userId}>
                        {t("sites:form.exemptEmployeesRemoveAction")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <HintText small>{t("sites:form.exemptEmployeesEmpty")}</HintText>
              )}

              <ErrorText>{exemptionError}</ErrorText>
            </div>
          ) : (
            <HintText small>{t("sitePolicy.noAssignmentsYet")}</HintText>
          )}

          <div style={{ marginTop: "var(--space-3)" }}>
            <Button onClick={handleSave} loading={saving}>
              {t("sitePolicy.saveAction")}
            </Button>
          </div>
          <ErrorText>{saveError}</ErrorText>
          {saved ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-sm)", color: "var(--status-success-text)" }}>{t("sitePolicy.saveSuccess")}</p> : null}
        </>
      ) : null}
    </Card>
  );
}
