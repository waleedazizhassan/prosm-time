import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import { getCurrentPosition } from "../../core/utils/geo";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import EvidenceCaptureField from "../../components/common/EvidenceCaptureField";

// PROSM Time WP-06/WP-08/§17/§16/§37 - real Clock In/Out on the
// Dashboard (Employee Mobile Home is a later, dedicated mobile-UX pass
// - this is the same real functionality on the screen every employee
// already lands on). Location is a best-effort capture only: WP-06
// never blocks a Clock In on a geolocation failure - GPS/geofence
// enforcement is WP-09's job. Camera evidence (§16) is required only
// when the selected/current site's own cameraRequired policy (§13) is
// on; the photo is uploaded after the clock event succeeds (the event
// must exist first - evidence links to it, §16), so an upload failure
// is surfaced as its own warning rather than undoing an attendance
// event that has already really happened.
export default function ClockInOutCard() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [evidenceWarning, setEvidenceWarning] = useState("");

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const [sessionResult, sitesResult] = await Promise.all([AttendanceRepository.getCurrentSession(profile.id), SiteRepository.listAssignedSites(profile.id)]);
    const activeSession = sessionResult.success ? sessionResult.data ?? null : null;
    setSession(activeSession);
    const assignedSites = sitesResult.success ? sitesResult.data ?? [] : [];
    setSites(assignedSites);
    setSiteId((current) => current || assignedSites[0]?.id || "");

    if (activeSession) {
      const siteResult = await SiteRepository.getSite(activeSession.siteId);
      setCurrentSite(siteResult.success ? siteResult.data ?? null : null);
    } else {
      setCurrentSite(null);
    }

    setEvidenceFile(null);
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    load();
  }, [load]);

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

    const result = await AttendanceRepository.clockIn({ siteId, projectId: projectId || null, latitude, longitude, accuracyMeters });

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

    const result = await AttendanceRepository.clockOut({ latitude, longitude, accuracyMeters });

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

  return (
    <Card title={t("attendance.title")}>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
      {evidenceWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{evidenceWarning}</p> : null}

      {session ? (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("attendance.clockedInSince", { time: new Date(session.clockInAt).toLocaleTimeString() })}</p>
          {clockOutCameraRequired ? <EvidenceCaptureField label={t("attendance.evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} required disabled={submitting} helperText={t("attendance.evidenceRequiredHint")} /> : null}
          <Button onClick={handleClockOut} loading={submitting} disabled={clockOutCameraRequired && !evidenceFile}>
            {t("attendance.clockOutAction")}
          </Button>
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
