import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin, Siren } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import PresenceRepository, { type PresenceSession } from "../../core/repositories/PresenceRepository";
import { getCurrentPosition, type CurrentPosition } from "../../core/utils/geo";
import playAlertSound from "../../core/utils/playAlertSound";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { reverseGeocodePlaceName } from "../../core/utils/reverseGeocode";
import { getDeviceLabel } from "../../core/utils/deviceInfo";
import OfflineQueueService from "../../core/offline/OfflineQueueService";
import { useOfflineQueue } from "../../core/offline/useOfflineQueue";
import { formatTimeOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import CameraCaptureModal from "../../components/common/CameraCaptureModal";
import Modal from "../../components/common/Modal";
import AttendanceConfirmModal from "../../components/common/AttendanceConfirmModal";
import LiveLocationMap from "../../components/common/LiveLocationMap";
import ErrorText from "../../components/common/ErrorText";
import styles from "./ClockInOutCard.module.css";

const PRESENCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

function formatElapsed(startIso: string, nowMs: number): string {
  const startMs = new Date(startIso).getTime();
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

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
//
// § final visual consistency pass, correction (Jibble mobile reference
// studied for information hierarchy only, not copied): Clock In/Out is
// the single primary action - tapping it is the one thing an employee
// does, and it orchestrates location + camera internally rather than
// requiring a separate Camera button pressed first. A status header
// (state pill + a live elapsed-time readout while clocked in) replaces
// a bare title, matching the "clear primary action + useful status
// information" hierarchy the reference material demonstrated, rendered
// entirely in PROSM's own StatusBadge/Button/token language.
export default function ClockInOutCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const [presenceSession, setPresenceSession] = useState<PresenceSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [manualLocationLabel, setManualLocationLabel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [cameraFor, setCameraFor] = useState<"clockIn" | "clockOut" | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [evidenceWarning, setEvidenceWarning] = useState("");
  const [sosSubmitting, setSosSubmitting] = useState(false);
  const [sosSent, setSosSent] = useState(false);
  const [activeBreakId, setActiveBreakId] = useState<string | null>(null);
  const [breakSubmitting, setBreakSubmitting] = useState(false);
  const [breakWarning, setBreakWarning] = useState("");
  // § live UX review, user-directed - mid-shift "Change Site": press
  // Pause before leaving the current site, then "Change Site" once
  // arrived at the next one - never clocks out, records the move.
  const [changeSiteModalOpen, setChangeSiteModalOpen] = useState(false);
  const [changeSiteTargetId, setChangeSiteTargetId] = useState("");
  const [changeSiteSubmitting, setChangeSiteSubmitting] = useState(false);
  const [changeSiteError, setChangeSiteError] = useState("");
  const [currentLocation, setCurrentLocation] = useState<CurrentPosition | null>(null);
  const [locationStatus, setLocationStatus] = useState<"detecting" | "available" | "unavailable">("detecting");
  const [placeName, setPlaceName] = useState<string | null>(null);
  // § live UX review, user-directed - "I'm at a different site every
  // day - shouldn't the geofence itself suggest it to me?" Sites the
  // employee isn't assigned to but is verifiably standing inside the
  // geofence of right now (SiteRepository.listNearbySites, a real
  // server-side GPS check) - merged into the picker, labeled
  // separately so it's clear this is a detected walk-in, not a formal
  // assignment.
  const [nearbySiteIds, setNearbySiteIds] = useState<Set<string>>(new Set());
  const [lastCompletedSession, setLastCompletedSession] = useState<AttendanceSession | null>(null);
  // § live UX review, user-directed - a real confirmation screen shown
  // right before every clock-in/out actually submits (photo if any,
  // GPS detail, site/workplace, time), with an optional note/activity
  // - not just when a photo was captured. handleClockInTap/
  // handleClockOutTap/handleCameraCapture all funnel here now instead
  // of calling performClockIn/performClockOut directly.
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"clockIn" | "clockOut" | null>(null);
  const [pendingEvidenceFile, setPendingEvidenceFile] = useState<File | null>(null);
  const [pendingPhotoPreviewUrl, setPendingPhotoPreviewUrl] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState("");

  useEffect(() => {
    if (!pendingEvidenceFile) {
      setPendingPhotoPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(pendingEvidenceFile);
    setPendingPhotoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingEvidenceFile]);

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
      const lastSessionResult = await AttendanceRepository.getLastCompletedSession(profile.id);
      setLastCompletedSession(lastSessionResult.success ? lastSessionResult.data ?? null : null);
    }

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
    setPlaceName(null);
    getCurrentPosition()
      .then((position) => {
        if (cancelled) return;
        setCurrentLocation(position);
        setLocationStatus("available");
        reverseGeocodePlaceName(position.latitude, position.longitude, i18n.language).then((name) => {
          if (!cancelled) setPlaceName(name);
        });
        SiteRepository.listNearbySites(position.latitude, position.longitude, position.accuracyMeters).then((result) => {
          if (cancelled || !result.success || !result.data || result.data.length === 0) return;
          setNearbySiteIds(new Set(result.data.map((site) => site.id)));
          setSites((current) => {
            const existingIds = new Set(current.map((site) => site.id));
            const additions = (result.data ?? [])
              .filter((nearby) => !existingIds.has(nearby.id))
              .map((nearby) => ({
                id: nearby.id,
                name: nearby.name,
                displayAddress: nearby.displayAddress,
                // Everything below this line is genuinely unknown for a
                // site the caller isn't assigned to (RLS never exposes
                // the full row until they're actually clocked in there -
                // see 20260903170100's own policy change) and unused by
                // anything client-side except cameraRequired, which the
                // nearby-sites RPC deliberately does return.
                latitude: position.latitude,
                longitude: position.longitude,
                allowedRadiusMeters: 0,
                gpsAccuracyToleranceMeters: 0,
                timezone: "UTC",
                isActive: true,
                attendanceAllowed: true,
                geofenceRequired: true,
                cameraRequired: nearby.cameraRequired,
                kioskMode: "personal_device_only" as const,
                graceToleranceMinutes: 0,
                shiftStartTime: null,
                shiftEndTime: null,
                overtimeStartTime: null,
                lateDeductionStartTime: null,
                breakRoundingMode: "cumulative" as const,
                blockSelfClockInAfterGrace: false,
                blockSelfClockOutOutsideGeofence: false,
                createdAt: new Date().toISOString(),
              }));
            return additions.length > 0 ? [...current, ...additions] : current;
          });
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLocationStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [i18n.language]);

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
        const result = await PresenceRepository.recordSample(current.id, position.latitude, position.longitude, position.accuracyMeters);
        // § live UX review, user-directed - "sound + reason + scheduled
        // reminder" when a mid-shift sample lands outside the site's
        // geofence: this is the immediate alert; ExceptionsCard's own
        // reminder loop keeps re-playing it until the employee submits
        // a reason.
        if (result.success && result.data?.exceptionCreated) {
          playAlertSound();
        }
      } catch {
        // Best-effort only - a failed/denied sample never surfaces as
        // an error, matching every other geolocation capture in this
        // component.
      }
    }, PRESENCE_SAMPLE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [presenceSession]);

  // Live elapsed-time readout while clocked in (§ final visual
  // consistency pass, correction - "useful status information" from
  // the Jibble reference's own Time Clock screen, reinvented here as a
  // ticking status-header field rather than that screen's map/pill
  // treatment). Purely a display tick - never read by any submit path.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!session) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [session]);

  if (!profile || loading) return null;

  const selectedSite = sites.find((site) => site.id === siteId) ?? null;
  // § live UX review, user-directed - "clock-in without a site doesn't
  // ask for a photo." With no site there is also no server-side
  // geofence check to fall back on (§ migration 20260901180000 -
  // compute_prosm_time_geofence_check is skipped entirely when
  // p_site_id is null), so a no-site attendance event has no location-
  // based verification at all unless the photo itself is required -
  // camera evidence becomes the one remaining verification signal, not
  // an optional one, exactly when there is no registered site's own
  // policy to defer to.
  const clockInCameraRequired = siteId ? selectedSite?.cameraRequired ?? false : true;
  const clockOutCameraRequired = currentSite ? currentSite.cameraRequired : true;

  // § final visual consistency pass, correction - "Clock In / Clock
  // Out must be the single primary attendance action... Camera is part
  // of the attendance flow, not a standalone feature/button." Evidence
  // is now a parameter passed in at the moment of submission, never a
  // pre-selected field the button waits on: handleClockInTap below
  // opens the camera itself (when the site requires it) and this
  // function only ever runs once a file already exists or none is
  // needed. Location capture and the offline-queue path are otherwise
  // byte-for-byte what WP-06/WP-15/§25 already established.
  const performClockIn = async (evidenceFile: File | null, note: string, activity: string) => {
    setSubmitting(true);
    setConfirmError("");
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

    const trimmedManualLabel = siteId ? null : manualLocationLabel.trim() || null;
    const trimmedNote = note.trim() || null;
    const trimmedActivity = activity.trim() || null;

    // WP-15/§25 - offline (or unreachable) is queued locally rather
    // than surfaced as an error; the client-captured time/coordinates/
    // evidence captured above travel with the queued item unchanged.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline(
        "clock_in",
        { siteId: siteId || null, manualLocationLabel: trimmedManualLabel, note: trimmedNote, activity: trimmedActivity, projectId: projectId || null, latitude, longitude, accuracyMeters },
        evidenceFile,
      );
      return;
    }

    const result = await AttendanceRepository.clockIn({
      siteId: siteId || null,
      manualLocationLabel: trimmedManualLabel,
      note: trimmedNote,
      activity: trimmedActivity,
      projectId: projectId || null,
      latitude,
      longitude,
      accuracyMeters,
    });

    if (result.networkError) {
      await queueOffline(
        "clock_in",
        { siteId: siteId || null, manualLocationLabel: trimmedManualLabel, note: trimmedNote, activity: trimmedActivity, projectId: projectId || null, latitude, longitude, accuracyMeters },
        evidenceFile,
      );
      return;
    }

    if (!result.success || !result.data) {
      setSubmitting(false);
      // § live UX review, user-directed - a site configured to block
      // self clock-in past its grace period raises this exact marker
      // (clock_in_prosm_time_attendance, 20260902130000) - shown as
      // its own distinct, richer message (deliberately NOT in
      // humanizeBackendError's map - this dedicated copy is better
      // than that generic fallback) rather than the generic clock-in
      // error, since there is no retry action here: the employee
      // genuinely cannot self-clock-in past this point and needs
      // their Manager to do it on their behalf.
      setConfirmError(
        result.message?.includes("CLOCK_IN_BLOCKED_CONTACT_MANAGER")
          ? t("attendance.clockInBlockedContactManager")
          : (humanizeBackendError(result.message, t) ?? t("attendance.clockInError"))
      );
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(humanizeBackendError(evidenceResult.message, t) ?? t("attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    setConfirmModalOpen(false);
    setConfirmAction(null);
    setPendingEvidenceFile(null);
    load();
  };

  const queueOffline = async (
    type: "clock_in" | "clock_out",
    location: {
      siteId?: string | null;
      manualLocationLabel?: string | null;
      note?: string | null;
      activity?: string | null;
      projectId?: string | null;
      latitude: number | null;
      longitude: number | null;
      accuracyMeters: number | null;
    },
    evidenceFile: File | null,
  ) => {
    if (!profile) {
      setSubmitting(false);
      return;
    }
    try {
      await OfflineQueueService.enqueue({
        userId: profile.id,
        type,
        siteId: location.siteId ?? null,
        manualLocationLabel: location.manualLocationLabel ?? null,
        note: location.note ?? null,
        activity: location.activity ?? null,
        projectId: location.projectId ?? null,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        clientReportedAt: new Date().toISOString(),
        evidenceFile,
      });
      setConfirmModalOpen(false);
      setConfirmAction(null);
      setPendingEvidenceFile(null);
    } catch (queueError) {
      setConfirmError(queueError instanceof Error ? queueError.message : t("attendance.offlineQueueError"));
    }
    setSubmitting(false);
  };

  const performClockOut = async (evidenceFile: File | null, note: string, activity: string) => {
    setSubmitting(true);
    setConfirmError("");
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
      // Best-effort only - see performClockIn.
    }

    const trimmedNote = note.trim() || null;
    const trimmedActivity = activity.trim() || null;

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline("clock_out", { note: trimmedNote, activity: trimmedActivity, latitude, longitude, accuracyMeters }, evidenceFile);
      return;
    }

    const result = await AttendanceRepository.clockOut({ note: trimmedNote, activity: trimmedActivity, latitude, longitude, accuracyMeters });

    if (result.networkError) {
      await queueOffline("clock_out", { note: trimmedNote, activity: trimmedActivity, latitude, longitude, accuracyMeters }, evidenceFile);
      return;
    }

    if (!result.success || !result.data) {
      setSubmitting(false);
      // § live UX review, user-directed - self clock-out outside a
      // real site's geofence can now be blocked outright
      // (clock_out_prosm_time_attendance, block_self_clock_out_outside_geofence)
      // mirroring the existing clock-in-after-grace block exactly -
      // same dedicated richer copy, same reasoning (no retry action
      // here, the employee needs their Manager to record it instead).
      setConfirmError(
        result.message?.includes("CLOCK_OUT_BLOCKED_CONTACT_MANAGER")
          ? t("attendance.clockOutBlockedContactManager")
          : (humanizeBackendError(result.message, t) ?? t("attendance.clockOutError"))
      );
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(humanizeBackendError(evidenceResult.message, t) ?? t("attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    setConfirmModalOpen(false);
    setConfirmAction(null);
    setPendingEvidenceFile(null);
    load();
  };

  const handleClockInTap = () => {
    if (!siteId && !manualLocationLabel.trim()) {
      setError(t("attendance.manualLocationRequired"));
      return;
    }
    setError("");
    if (clockInCameraRequired) {
      setCameraFor("clockIn");
      return;
    }
    setPendingEvidenceFile(null);
    setConfirmError("");
    setConfirmAction("clockIn");
    setConfirmModalOpen(true);
  };

  const handleClockOutTap = () => {
    if (clockOutCameraRequired) {
      setCameraFor("clockOut");
      return;
    }
    setPendingEvidenceFile(null);
    setConfirmError("");
    setConfirmAction("clockOut");
    setConfirmModalOpen(true);
  };

  const handleCameraCapture = (file: File) => {
    const pending = cameraFor;
    setCameraFor(null);
    setPendingEvidenceFile(file);
    setConfirmError("");
    setConfirmAction(pending);
    setConfirmModalOpen(true);
  };

  const handleCameraClose = () => {
    setCameraFor(null);
  };

  const handleConfirmCancel = () => {
    if (submitting) return;
    setConfirmModalOpen(false);
    setConfirmAction(null);
    setPendingEvidenceFile(null);
    setConfirmError("");
  };

  const handleConfirmSubmit = (note: string, activity: string) => {
    if (confirmAction === "clockIn") performClockIn(pendingEvidenceFile, note, activity);
    else if (confirmAction === "clockOut") performClockOut(pendingEvidenceFile, note, activity);
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
      setError(humanizeBackendError(result.message, t) ?? t("attendance.sosError"));
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
        setError(humanizeBackendError(result.message, t) ?? t("attendance.breakEndError"));
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
        setError(humanizeBackendError(result.message, t) ?? t("attendance.breakStartError"));
        return;
      }
      setActiveBreakId(result.data.breakId);
    }
  };

  const handleOpenChangeSiteModal = () => {
    setChangeSiteTargetId("");
    setChangeSiteError("");
    setChangeSiteModalOpen(true);
  };

  const handleCloseChangeSiteModal = () => {
    if (changeSiteSubmitting) return;
    setChangeSiteModalOpen(false);
  };

  const handleConfirmChangeSite = async () => {
    if (!activeBreakId || !changeSiteTargetId) return;
    setChangeSiteSubmitting(true);
    setChangeSiteError("");

    let latitude: number | null = null;
    let longitude: number | null = null;
    let accuracyMeters: number | null = null;
    try {
      const position = await getCurrentPosition();
      latitude = position.latitude;
      longitude = position.longitude;
      accuracyMeters = position.accuracyMeters;
    } catch {
      // Best-effort, same posture as SOS - the server re-verifies the
      // geofence itself and rejects when it can't confirm presence.
    }

    const result = await AttendanceRepository.changeSite(activeBreakId, changeSiteTargetId, latitude, longitude, accuracyMeters);
    setChangeSiteSubmitting(false);

    if (!result.success) {
      setChangeSiteError(humanizeBackendError(result.message, t) ?? t("attendance.changeSiteError"));
      return;
    }

    if (result.data?.maxDurationExceeded) {
      setBreakWarning(t("attendance.breakExceeded"));
    }

    setChangeSiteModalOpen(false);
    setActiveBreakId(null);
    load();
  };

  const statusKey = activeBreakId ? "onBreak" : session ? "clockedIn" : "notClockedIn";
  const changeSiteOptions = sites
    .filter((site) => site.id !== currentSite?.id)
    .map((site) => ({ value: site.id, label: nearbySiteIds.has(site.id) ? t("attendance.nearbySiteOption", { name: site.name }) : site.name }));
  const mapRelevantSite = session ? currentSite : selectedSite;
  const confirmSiteName =
    confirmAction === "clockOut"
      ? currentSite?.name ?? session?.manualLocationLabel ?? ""
      : selectedSite?.name ?? (manualLocationLabel.trim() || t("attendance.noSiteOption"));

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}>
        <span style={{ fontSize: "var(--font-xs)", fontWeight: "var(--font-weight-bold)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-secondary)" }}>
          {t("attendance.title")}
        </span>
        <StatusBadge status={statusKey}>{t(`attendance.status.${statusKey}`)}</StatusBadge>
      </div>

      {session ? (
        <div style={{ margin: "var(--space-3) 0" }}>
          <div style={{ fontSize: "var(--font-3xl)", fontWeight: "var(--font-weight-bold)", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
            {formatElapsed(session.clockInAt, now)}
          </div>
          <p style={{ margin: "var(--space-1) 0 0", color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
            {t("attendance.clockedInSince", { time: formatTimeOnly(session.clockInAt, i18n.language) })}
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: "var(--space-3)" }}>
        <LiveLocationMap
          latitude={currentLocation?.latitude ?? null}
          longitude={currentLocation?.longitude ?? null}
          site={
            mapRelevantSite
              ? { name: mapRelevantSite.name, latitude: mapRelevantSite.latitude, longitude: mapRelevantSite.longitude, allowedRadiusMeters: mapRelevantSite.allowedRadiusMeters }
              : null
          }
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          margin: "var(--space-3) 0",
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface-hover)",
          color: locationStatus === "unavailable" ? "var(--status-warning-text)" : "var(--text-secondary)",
          fontSize: "var(--font-xs)",
        }}
      >
        <MapPin size={14} style={{ flexShrink: 0, color: locationStatus === "available" ? "var(--brand-primary)" : undefined }} />
        {locationStatus === "detecting" ? (
          <span>{t("attendance.locationDetecting")}</span>
        ) : locationStatus === "available" && currentLocation ? (
          <span>
            {placeName ?? `${currentLocation.latitude.toFixed(5)}, ${currentLocation.longitude.toFixed(5)}`}
            {" "}
            ({t("attendance.locationAccuracy", { meters: Math.round(currentLocation.accuracyMeters) })})
          </span>
        ) : (
          <span>{t("attendance.locationUnavailable")}</span>
        )}
      </div>

      <ErrorText>{error}</ErrorText>
      {evidenceWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{evidenceWarning}</p> : null}
      {breakWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{breakWarning}</p> : null}

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
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <Button variant="danger" fullWidth onClick={handleClockOutTap} loading={submitting}>
              {t("attendance.clockOutAction")}
            </Button>
            <Button variant="ghost" fullWidth onClick={handleToggleBreak} loading={breakSubmitting}>
              {activeBreakId ? t("attendance.breakEndAction") : t("attendance.breakStartAction")}
            </Button>
            {activeBreakId ? (
              <Button variant="ghost" fullWidth onClick={handleOpenChangeSiteModal}>
                {t("attendance.changeSiteAction")}
              </Button>
            ) : null}
          </div>

          {presenceSession ? (
            <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-light)" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)" }}>{t("attendance.presenceActive")}</p>
              {sosSent ? (
                <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("attendance.sosSent")}</p>
              ) : (
                <Button variant="danger" className={styles.sosButton} onClick={handleSos} loading={sosSubmitting}>
                  <Siren size={18} />
                  {t("attendance.sosAction")}
                </Button>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {/* § live UX review, user-directed - "the confirm-clock-in
              step should be clear, smooth, and show who's clocking in,
              from what device, and when they last clocked out"
              (reference-app screenshots studied for information
              hierarchy only, not copied - same posture as this whole
              component's own header comment). All display-only, no new
              submitted field: name/device are read straight from
              profile/navigator, last-out is one new small repository
              read (AttendanceRepository.getLastCompletedSession). */}
          {profile ? (
            <div style={{ margin: "0 0 var(--space-3)" }}>
              <p style={{ margin: 0, fontSize: "var(--font-lg)", fontWeight: "var(--font-weight-bold)", color: "var(--text-primary)" }}>{profile.fullName}</p>
              <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                {t("attendance.viaDevice", { device: getDeviceLabel() })}
                {lastCompletedSession?.clockOutAt ? ` · ${t("attendance.lastClockOut", { time: formatTimeOnly(lastCompletedSession.clockOutAt, i18n.language) })}` : ""}
              </p>
            </div>
          ) : null}

          {/* § live UX review, user-directed - "site should be optional;
              the important thing is registering attendance at the
              employee's actual current location, since they may be
              working somewhere not registered as a work site." Site
              stays the default, preferred choice when one is assigned
              (still first in the list, still auto-selected by load()
              below), but "No site" is now a real, always-available
              option rather than sites.length === 0 being a dead end
              with no way to clock in at all. */}
          <Select
            label={t("attendance.siteLabel")}
            name="clockInSite"
            value={siteId}
            onChange={(event) => {
              setSiteId(event.target.value);
              if (event.target.value) setManualLocationLabel("");
            }}
            disabled={submitting}
            options={[
              { value: "", label: t("attendance.noSiteOption") },
              ...sites.map((site) => ({ value: site.id, label: nearbySiteIds.has(site.id) ? t("attendance.nearbySiteOption", { name: site.name }) : site.name })),
            ]}
          />
          {!siteId ? (
            <Input
              label={t("attendance.manualLocationLabel")}
              name="clockInManualLocation"
              value={manualLocationLabel}
              onChange={(event) => setManualLocationLabel(event.target.value)}
              disabled={submitting}
              required
              helperText={t("attendance.manualLocationHint")}
            />
          ) : null}
          {siteId ? (
            <Select
              label={t("attendance.projectLabel")}
              name="clockInProject"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={submitting || projects.length === 0}
              options={[{ value: "", label: t("attendance.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            />
          ) : null}
          <Button fullWidth onClick={handleClockInTap} loading={submitting} disabled={!siteId && !manualLocationLabel.trim()}>
            {t("attendance.clockInAction")}
          </Button>
        </>
      )}

      <CameraCaptureModal isOpen={cameraFor !== null} onClose={handleCameraClose} onCapture={handleCameraCapture} />

      {confirmAction ? (
        <AttendanceConfirmModal
          isOpen={confirmModalOpen}
          action={confirmAction}
          photoPreviewUrl={pendingPhotoPreviewUrl}
          latitude={currentLocation?.latitude ?? null}
          longitude={currentLocation?.longitude ?? null}
          accuracyMeters={currentLocation?.accuracyMeters ?? null}
          placeName={placeName}
          siteName={confirmSiteName}
          submitting={submitting}
          error={confirmError}
          onCancel={handleConfirmCancel}
          onConfirm={handleConfirmSubmit}
        />
      ) : null}

      <Modal
        isOpen={changeSiteModalOpen}
        onClose={handleCloseChangeSiteModal}
        title={t("attendance.changeSiteModalTitle")}
        footer={
          <Button fullWidth onClick={handleConfirmChangeSite} loading={changeSiteSubmitting} disabled={!changeSiteTargetId}>
            {t("attendance.changeSiteConfirmAction")}
          </Button>
        }
      >
        <Select
          label={t("attendance.siteLabel")}
          name="changeSiteTarget"
          value={changeSiteTargetId}
          onChange={(event) => setChangeSiteTargetId(event.target.value)}
          disabled={changeSiteSubmitting}
          options={[{ value: "", label: t("attendance.changeSitePickPlaceholder") }, ...changeSiteOptions]}
        />
        <ErrorText>{changeSiteError}</ErrorText>
      </Modal>
    </Card>
  );
}
