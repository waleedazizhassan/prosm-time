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
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import EvidenceCaptureField from "../../components/common/EvidenceCaptureField";

interface AdminAttendanceCardProps {
  subjectUserId: string;
}

// PROSM Time WP-07/WP-08/§10/§16 - "Administrative Clock In / Clock
// Out (On Behalf Of)." Site/project pickers are scoped to what the
// SUBJECT (the employee this page is about) is assigned to, not the
// caller - the on-behalf RPCs re-check the subject's own
// site_assignments/project_assignments server-side regardless. A
// reason is always required; the caller (the administrator) is
// captured as ACTOR server-side, never this employee. Camera evidence
// (§16) is required only when the selected/current site's own
// cameraRequired policy (§13) is on, uploaded by the administrator
// performing the action (attach_prosm_time_camera_evidence authorizes
// the event's own recorded_by, not just its user_id).
export default function AdminAttendanceCard({ subjectUserId }: AdminAttendanceCardProps) {
  const { t } = useTranslation("people");
  const { hasPermission } = useAuth();

  const canClockIn = hasPermission("attendance.clock_in_on_behalf");
  const canClockOut = hasPermission("attendance.clock_out_on_behalf");

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [evidenceWarning, setEvidenceWarning] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [sessionResult, sitesResult] = await Promise.all([AttendanceRepository.getCurrentSession(subjectUserId), SiteRepository.listAssignedSites(subjectUserId)]);
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
  }, [subjectUserId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!siteId) {
      setProjects([]);
      setProjectId("");
      return;
    }
    ProjectRepository.listAssignedProjectsForSite(subjectUserId, siteId).then((result) => {
      const list = result.success ? result.data ?? [] : [];
      setProjects(list);
      setProjectId("");
    });
  }, [subjectUserId, siteId]);

  if (!canClockIn && !canClockOut) return null;

  const selectedSite = sites.find((site) => site.id === siteId) ?? null;
  const clockInCameraRequired = selectedSite?.cameraRequired ?? false;
  const clockOutCameraRequired = currentSite?.cameraRequired ?? false;

  const handleClockIn = async () => {
    if (!siteId || !reason.trim()) return;
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
      // Best-effort only, same posture as the employee's own Clock In.
    }

    const result = await AttendanceRepository.adminClockIn({ subjectUserId, siteId, projectId: projectId || null, reason: reason.trim(), latitude, longitude, accuracyMeters });

    if (!result.success || !result.data) {
      setSubmitting(false);
      setError(result.message ?? t("detail.attendance.clockInError"));
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(evidenceResult.message ?? t("detail.attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    setReason("");
    load();
  };

  const handleClockOut = async () => {
    if (!reason.trim()) return;
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

    const result = await AttendanceRepository.adminClockOut({ subjectUserId, reason: reason.trim(), latitude, longitude, accuracyMeters });

    if (!result.success || !result.data) {
      setSubmitting(false);
      setError(result.message ?? t("detail.attendance.clockOutError"));
      return;
    }

    if (evidenceFile) {
      const evidenceResult = await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
      if (!evidenceResult.success) {
        setEvidenceWarning(evidenceResult.message ?? t("detail.attendance.evidenceUploadError"));
      }
    }

    setSubmitting(false);
    setReason("");
    load();
  };

  if (loading) return null;

  return (
    <Card title={t("detail.attendance.title")}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.attendance.hint")}</p>

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
      {evidenceWarning ? <p style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{evidenceWarning}</p> : null}

      {session ? (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.attendance.clockedInSince", { time: new Date(session.clockInAt).toLocaleTimeString() })}</p>
          {canClockOut ? (
            <>
              <Textarea label={t("detail.attendance.reasonLabel")} name="adminClockOutReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
              {clockOutCameraRequired ? (
                <EvidenceCaptureField label={t("detail.attendance.evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} required disabled={submitting} helperText={t("detail.attendance.evidenceRequiredHint")} />
              ) : null}
              <Button onClick={handleClockOut} loading={submitting} disabled={!reason.trim() || (clockOutCameraRequired && !evidenceFile)}>
                {t("detail.attendance.clockOutAction")}
              </Button>
            </>
          ) : null}
        </>
      ) : canClockIn ? (
        sites.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.attendance.noAssignedSites")}</p>
        ) : (
          <>
            <Select label={t("detail.attendance.siteLabel")} name="adminClockInSite" value={siteId} onChange={(event) => setSiteId(event.target.value)} disabled={submitting} options={sites.map((site) => ({ value: site.id, label: site.name }))} />
            <Select
              label={t("detail.attendance.projectLabel")}
              name="adminClockInProject"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={submitting || projects.length === 0}
              options={[{ value: "", label: t("detail.attendance.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            />
            <Textarea label={t("detail.attendance.reasonLabel")} name="adminClockInReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
            {clockInCameraRequired ? (
              <EvidenceCaptureField label={t("detail.attendance.evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} required disabled={submitting} helperText={t("detail.attendance.evidenceRequiredHint")} />
            ) : null}
            <Button onClick={handleClockIn} loading={submitting} disabled={!siteId || !reason.trim() || (clockInCameraRequired && !evidenceFile)}>
              {t("detail.attendance.clockInAction")}
            </Button>
          </>
        )
      ) : (
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.attendance.notClockedIn")}</p>
      )}
    </Card>
  );
}
