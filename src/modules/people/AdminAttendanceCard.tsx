import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import { getCurrentPosition } from "../../core/utils/geo";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";

interface AdminAttendanceCardProps {
  subjectUserId: string;
}

// PROSM Time WP-07/§10 - "Administrative Clock In / Clock Out (On
// Behalf Of)." Site/project pickers are scoped to what the SUBJECT
// (the employee this page is about) is assigned to, not the caller -
// the on-behalf RPCs re-check the subject's own site_assignments/
// project_assignments server-side regardless. A reason is always
// required; the caller (the administrator) is captured as ACTOR
// server-side, never this employee.
export default function AdminAttendanceCard({ subjectUserId }: AdminAttendanceCardProps) {
  const { t } = useTranslation("people");
  const { hasPermission } = useAuth();

  const canClockIn = hasPermission("attendance.clock_in_on_behalf");
  const canClockOut = hasPermission("attendance.clock_out_on_behalf");

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [sessionResult, sitesResult] = await Promise.all([AttendanceRepository.getCurrentSession(subjectUserId), SiteRepository.listAssignedSites(subjectUserId)]);
    setSession(sessionResult.success ? sessionResult.data ?? null : null);
    const assignedSites = sitesResult.success ? sitesResult.data ?? [] : [];
    setSites(assignedSites);
    setSiteId((current) => current || assignedSites[0]?.id || "");
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

  const handleClockIn = async () => {
    if (!siteId || !reason.trim()) return;
    setSubmitting(true);
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
      // Best-effort only, same posture as the employee's own Clock In.
    }

    const result = await AttendanceRepository.adminClockIn({ subjectUserId, siteId, projectId: projectId || null, reason: reason.trim(), latitude, longitude, accuracyMeters });

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("detail.attendance.clockInError"));
      return;
    }

    setReason("");
    load();
  };

  const handleClockOut = async () => {
    if (!reason.trim()) return;
    setSubmitting(true);
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
      // Best-effort only - see handleClockIn.
    }

    const result = await AttendanceRepository.adminClockOut({ subjectUserId, reason: reason.trim(), latitude, longitude, accuracyMeters });

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("detail.attendance.clockOutError"));
      return;
    }

    setReason("");
    load();
  };

  if (loading) return null;

  return (
    <Card title={t("detail.attendance.title")}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.attendance.hint")}</p>

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}

      {session ? (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.attendance.clockedInSince", { time: new Date(session.clockInAt).toLocaleTimeString() })}</p>
          {canClockOut ? (
            <>
              <Textarea label={t("detail.attendance.reasonLabel")} name="adminClockOutReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
              <Button onClick={handleClockOut} loading={submitting} disabled={!reason.trim()}>
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
            <Button onClick={handleClockIn} loading={submitting} disabled={!siteId || !reason.trim()}>
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
