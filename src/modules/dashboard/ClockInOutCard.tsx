import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import PresenceRepository, { type PresenceSession } from "../../core/repositories/PresenceRepository";
import { getCurrentPosition, type CurrentPosition } from "../../core/utils/geo";
import OfflineQueueService from "../../core/offline/OfflineQueueService";
import { useOfflineQueue } from "../../core/offline/useOfflineQueue";
import { formatTimeOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import EvidenceCaptureField from "../../components/common/EvidenceCaptureField";

const PRESENCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

// PROSM Time WP-06/WP-08/WP-10/§17/§16/§18/§37 - real Clock In/Out on
// the Dashboard (Employee Mobile Home is a later, dedicated mobile-UX
// pass - this is the same real functionality on the screen every
// employee already lands on). Location is a best-effort capture only:
// WP-06 never blocks a Clock In on a geolocation failure - GPS/geofence
// enforcement is WP-09's job. Camera evidence (§16) is required only
// when the selected/current site's own cameraRequired policy (§13) is
// on. Presence monitoring (§18) starts automatically at Clock In only
// when the site's own presence_monitoring_enabled policy is on
// (WP-06's RPC decides this server-side, never the client) - while
// active, this component silently submits a periodic location sample
// ("controlled location sampling", tab must stay open - no background
// service worker, matching §15's own "subject to platform/browser
// capabilities" caveat) and surfaces the SOS/Emergency action, which
// is only ever reachable during an active presence session (§18).
export default function ClockInOutCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const [presenceSession, setPresenceSession] = useState<PresenceSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [evidenceWarning, setEvidenceWarning] = useState("");
  const [sosSubmitting, setSosSubmitting] = useState(false);
  const [sosSent, setSosSent] = useState(false);
  const [activeBreakId, setActiveBreakId] = useState<string | null>(null);
  const [breakSubmitting, setBreakSubmitting] = useState(false);
  const [breakWarning, setBreakWarning] = useState("");
  const [currentLocation, setCurrentLocation] = useState<CurrentPosition | null>(null);
  const [locationStatus, setLocationStatus] = useState<"detecting" | "available" | "unavailable">("detecting");

  const presenceSessionRef = useRef<PresenceSession | null>(null);
  presenceSessionRef.current = presenceSession;

  const pendingOfflineItems = useOfflineQueue(profile?.id);
  const pendingOfflineItem = pendingOfflineItems[0] ?? null;

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const [sessionResult, sitesResult, presenceResult] = await Promise.all([
      AttendanceRepository.getCurrentSession(profile.id),
      SiteRepository.listAssignedSites(profile.id),
      PresenceRepository.getActiveSession(profile.id),
    ]);
    const activeSession = sessionResult.success ? sessionResult.data ?? null : null;
    setSession(activeSession);
    setPresenceSession(presenceResult.success ? presenceResult.data ?? null : null);
    const assignedSites = sitesResult.success ? sitesResult.data ?? [] : [];
    setSites(assignedSites);
    setSiteId((current) => current || assignedSites[0]?.id || "");

    if (activeSession) {
      const siteResult = await SiteRepository.getSite(activeSession.siteId);
      setCurrentSite(siteResult.success ? siteResult.data ?? null : null);
      const breakResult = await AttendanceRepository.getActiveBreak(activeSession.id);
      setActiveBreakId(breakResult.success ? breakResult.data?.id ?? null : null);
    } else {
      setCurrentSite(null);
      setActiveBreakId(null);
    }

    setEvidenceFile(null);
    setSosSent(false);
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    load();
  }, [load]);

  // WP-15 - once a queued action finally syncs (or a failed one is
  // discarded), the real session state on the server may have
  // changed - re-fetch it rather than trusting whatever was on screen
  // while the action sat unsynced.
  const previousPendingIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentId = pendingOfflineItem?.id ?? null;
    if (previousPendingIdRef.current && !currentId) {
      load();
    }
    previousPendingIdRef.current = currentId;
  }, [pendingOfflineItem, load]);

  // § final visual consistency pass, user-directed - "During mobile
  // Clock In, obtain the device's current location... clearly display
  // the detected/current location to the employee." Display-only: a
  // fresh, independent best-effort read is still taken at the moment
  // Clock In/Out is actually pressed (handleClockIn/handleClockOut,
  // unchanged below) and is the ONLY sample ever sent to the server -
  // this effect never feeds the submitted reading, and the server-side
  // geofence decision (WP-09) is entirely untouched.
  useEffect(() => {
    let cancelled = false;
    setLocationStatus("detecting");
    getCurrentPosition()
      .then((position) => {
        if (cancelled) return;
        setCurrentLocation(position);
        setLocationStatus("available");
      })
      .catch(() => {
        if (cancelled) return;
        setLocationStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!profile || !siteId) {
      setProjects([]);
      setProjectId("");
      return;
    }
    ProjectRepository.listAssignedProjectsForSite(profile.id, siteId).then((result) => {
      const list = result.success ? result.data ?? [] : [];
      setProjects(list);
      setProjectId("");
    });
  }, [profile, siteId]);

  // §18: "location samples collected per policy and platform
  // capability" - only runs while a presence session is genuinely
  // active, stops the instant it isn't (interval cleared on unmount/
  // dependency change, matching "no active presence tracking after
  // Clock Out").
  useEffect(() => {
    if (!presenceSession) return undefined;

    const interval = setInterval(async () => {
      const current = presenceSessionRef.current;
      if (!current) return;
      try {
        const position = await getCurrentPosition();
        await PresenceRepository.recordSample(current.id, position.latitude, position.longitude, position.accuracyMeters);
      } catch {
        // Best-effort only - a failed/denied sample never surfaces as
        // an error, matching every other geolocation capture in this
        // component.
      }
    }, PRESENCE_SAMPLE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [presenceSession]);

  if (!profile || loading) return null;

  const selectedSite = sites.find((site) => site.id === siteId) ?? null;
  const clockInCameraRequired = selectedSite?.cameraRequired ?? false;
  const clockOutCameraRequired = currentSite?.cameraRequired ?? false;

  const handleClockIn = async () => {
    if (!siteId) return;
    if (clockInCameraRequired && !evidenceFile) return;
    setSubmitting(true);
    setError("");
    setEvidenceWarning("");

    let latitude: number | null = null;
    let longitude: number | null = null;
    let accuracyMeters: number | null = null;
    try {
      const position = await getCurrentPosition();
      latitude = position.latitude;
      longitude = position.longitude;
      accuracyMeters = position.accuracyMeters;
    } catch {
      // Best-effort only (see file header) - proceed without a
      // location sample rather than blocking the Clock In.
    }

    // WP-15/§25 - offline (or unreachable) is queued locally rather
    // than surfaced as an error; the client-captured time/coordinates/
    // evidence captured above travel with the queued item unchanged.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline("clock_in", { siteId, projectId: projectId || null, latitude, longitude, accuracyMeters });
      return;
    }

    const result = await AttendanceRepository.clockIn({ siteId, projectId: projectId || null, latitude, longitude, accuracyMeters });

    if (result.networkError) {
      await queueOffline("clock_in", { siteId, projectId: projectId || null, latitude, longitude, accuracyMeters });
      return;
    }

    if (!result.success || !result.data) {
      setSubmitting(false);
      setError(result.message ?? t("attendance.clockInError"));
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(evidenceResult.message ?? t("attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    load();
  };

  const queueOffline = async (type: "clock_in" | "clock_out", location: { siteId?: string; projectId?: string | null; latitude: number | null; longitude: number | null; accuracyMeters: number | null }) => {
    if (!profile) {
      setSubmitting(false);
      return;
    }
    try {
      await OfflineQueueService.enqueue({
        userId: profile.id,
        type,
        siteId: location.siteId ?? null,
        projectId: location.projectId ?? null,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        clientReportedAt: new Date().toISOString(),
        evidenceFile: evidenceFile ?? null,
      });
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : t("attendance.offlineQueueError"));
    }
    setSubmitting(false);
  };

  const handleClockOut = async () => {
    if (clockOutCameraRequired && !evidenceFile) return;
    setSubmitting(true);
    setError("");
    setEvidenceWarning("");

    let latitude: number | null = null;
    let longitude: number | null = null;
    let accuracyMeters: number | null = null;
    try {
      const position = await getCurrentPosition();
      latitude = position.latitude;
      longitude = position.longitude;
      accuracyMeters = position.accuracyMeters;
    } catch {
      // Best-effort only - see handleClockIn.
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline("clock_out", { latitude, longitude, accuracyMeters });
      return;
    }

    const result = await AttendanceRepository.clockOut({ latitude, longitude, accuracyMeters });

    if (result.networkError) {
      await queueOffline("clock_out", { latitude, longitude, accuracyMeters });
      return;
    }

    if (!result.success || !result.data) {
      setSubmitting(false);
      setError(result.message ?? t("attendance.clockOutError"));
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(evidenceResult.message ?? t("attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    load();
  };

  const handleRetryOfflineSync = async () => {
    if (!pendingOfflineItem) return;
    await OfflineQueueService.retry(pendingOfflineItem.id);
  };

  const handleDiscardOfflineItem = async () => {
    if (!pendingOfflineItem) return;
    await OfflineQueueService.discard(pendingOfflineItem.id);
  };

  const handleSos = async () => {
    if (!presenceSession) return;
    setSosSubmitting(true);
    setError("");

    let latitude: number | null = null;
    let longitude: number | null = null;
    let accuracyMeters: number | null = null;
    try {
      const position = await getCurrentPosition();
      latitude = position.latitude;
      longitude = position.longitude;
      accuracyMeters = position.accuracyMeters;
    } catch {
      // SOS must still fire without a location sample - safety comes
      // first, geolocation is still best-effort.
    }

    const result = await PresenceRepository.triggerSos(presenceSession.id, latitude, longitude, accuracyMeters);

    setSosSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("attendance.sosError"));
      return;
    }

    setSosSent(true);
  };

  const handleToggleBreak = async () => {
    if (!session) return;
    setBreakSubmitting(true);
    setError("");
    setBreakWarning("");

    if (activeBreakId) {
      const result = await AttendanceRepository.endBreak(activeBreakId);
      setBreakSubmitting(false);
      if (!result.success) {
        setError(result.message ?? t("attendance.breakEndError"));
        return;
      }
      if (result.data?.maxDurationExceeded) {
        setBreakWarning(t("attendance.breakExceeded"));
      }
      setActiveBreakId(null);
    } else {
      const result = await AttendanceRepository.startBreak(session.id);
      setBreakSubmitting(false);
      if (!result.success || !result.data) {
        setError(result.message ?? t("attendance.breakStartError"));
        return;
      }
      setActiveBreakId(result.data.breakId);
    }
  };

  return (
    <Card title={t("attendance.title")}>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
      {evidenceWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{evidenceWarning}</p> : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface-hover)",
          color: locationStatus === "unavailable" ? "var(--status-warning-text)" : "var(--text-secondary)",
          fontSize: "var(--font-xs)",
        }}
      >
        <MapPin size={14} style={{ flexShrink: 0 }} />
        {locationStatus === "detecting" ? (
          <span>{t("attendance.locationDetecting")}</span>
        ) : locationStatus === "available" && currentLocation ? (
          <span>
            {t("attendance.locationLabel")}: {currentLocation.latitude.toFixed(5)}, {currentLocation.longitude.toFixed(5)}
            {" "}
            ({t("attendance.locationAccuracy", { meters: Math.round(currentLocation.accuracyMeters) })})
          </span>
        ) : (
          <span>{t("attendance.locationUnavailable")}</span>
        )}
      </div>

      {pendingOfflineItem ? (
        <div style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-hover)" }}>
          <p style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)" }}>
            {pendingOfflineItem.type === "clock_in" ? t("attendance.pendingClockIn") : t("attendance.pendingClockOut")}
          </p>
          <p style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {pendingOfflineItem.status === "failed"
              ? pendingOfflineItem.errorMessage ?? t("attendance.pendingSyncFailed")
              : pendingOfflineItem.status === "syncing"
                ? t("attendance.pendingSyncing")
                : t("attendance.pendingWaitingForConnection")}
          </p>
          {pendingOfflineItem.status === "failed" ? (
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
              <Button size="sm" onClick={handleRetryOfflineSync}>
                {t("attendance.retrySync")}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDiscardOfflineItem}>
                {t("attendance.discardPending")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : session ? (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("attendance.clockedInSince", { time: formatTimeOnly(session.clockInAt, i18n.language) })}</p>
          {breakWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{breakWarning}</p> : null}
          {clockOutCameraRequired ? <EvidenceCaptureField label={t("attendance.evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} required disabled={submitting} helperText={t("attendance.evidenceRequiredHint")} /> : null}
          <Button onClick={handleClockOut} loading={submitting} disabled={clockOutCameraRequired && !evidenceFile}>
            {t("attendance.clockOutAction")}
          </Button>
          <Button variant="ghost" onClick={handleToggleBreak} loading={breakSubmitting} style={{ marginTop: "var(--space-2)" }}>
            {activeBreakId ? t("attendance.breakEndAction") : t("attendance.breakStartAction")}
          </Button>

          {presenceSession ? (
            <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-light)" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)" }}>{t("attendance.presenceActive")}</p>
              {sosSent ? (
                <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("attendance.sosSent")}</p>
              ) : (
                <Button variant="danger" onClick={handleSos} loading={sosSubmitting}>
                  {t("attendance.sosAction")}
                </Button>
              )}
            </div>
          ) : null}
        </>
      ) : sites.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("attendance.noAssignedSites")}</p>
      ) : (
        <>
          <Select label={t("attendance.siteLabel")} name="clockInSite" value={siteId} onChange={(event) => setSiteId(event.target.value)} disabled={submitting} options={sites.map((site) => ({ value: site.id, label: site.name }))} />
          <Select
            label={t("attendance.projectLabel")}
            name="clockInProject"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={submitting || projects.length === 0}
            options={[{ value: "", label: t("attendance.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
          />
          {clockInCameraRequired ? <EvidenceCaptureField label={t("attendance.evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} required disabled={submitting} helperText={t("attendance.evidenceRequiredHint")} /> : null}
          <Button onClick={handleClockIn} loading={submitting} disabled={!siteId || (clockInCameraRequired && !evidenceFile)}>
            {t("attendance.clockInAction")}
          </Button>
        </>
      )}
    </Card>
  );
}
