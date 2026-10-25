import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import { getCurrentPosition } from "../../core/utils/geo";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import { formatTimeOnly } from "../../core/utils/formatDate";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

interface AdminAttendanceCardProps {
  subjectUserId: string;
  subjectFullName: string;
}

// PROSM Time WP-07/§10 - "Administrative Clock In / Clock Out (On
// Behalf Of)." Site/project pickers are scoped to what the SUBJECT
// (the employee this page is about) is assigned to, not the caller -
// the on-behalf RPCs re-check the subject's own site_assignments/
// project_assignments server-side regardless. A reason is always
// required; the caller (the administrator) is captured as ACTOR
// server-side, never this employee.
//
// § final visual consistency pass, correction - "When an administrator
// performs Clock In/Out ON BEHALF OF an employee: do NOT open or
// require the administrator's camera... instead clearly show who
// performed the action, the employee/subject, and the reason." §16
// camera evidence is an EMPLOYEE'S OWN presence proof - it has no
// meaning for an action the employee wasn't present to perform, so it
// is never requested here regardless of the site's cameraRequired
// policy. actor/subject/reason are shown in the UI below instead (the
// actor is always "you" here, since only an authorized admin/manager
// reaches this card at all - WP-07's ACTOR/SUBJECT distinction and its
// server-side re-authorization are entirely unchanged).
// v2.3.43 step 10: the "no registered site" choice (a place name is written instead).
const NO_SITE = "__no_site__";

export default function AdminAttendanceCard({ subjectUserId, subjectFullName }: AdminAttendanceCardProps) {
  const { t, i18n } = useTranslation("people");
  const { hasPermission, profile } = useAuth();

  const canClockIn = hasPermission("attendance.clock_in_on_behalf");
  const canClockOut = hasPermission("attendance.clock_out_on_behalf");

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  // v2.3.43 step 10 (item 9): the time (empty = now) and a place name when no site applies.
  const [occurredAt, setOccurredAt] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [sessionResult, sitesResult] = await Promise.all([AttendanceRepository.getCurrentSession(subjectUserId), SiteRepository.listAssignedSites(subjectUserId)]);
    const activeSession = sessionResult.success ? sessionResult.data ?? null : null;
    setSession(activeSession);
    const assignedSites = sitesResult.success ? sitesResult.data ?? [] : [];
    setSites(assignedSites);
    setSiteId((current) => current || assignedSites[0]?.id || NO_SITE);
    setLoading(false);
  }, [subjectUserId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!siteId || siteId === NO_SITE) {
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
    if (!siteId || !reason.trim() || (siteId === NO_SITE && !placeName.trim())) return;
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

    const result = await AttendanceRepository.adminClockIn({
      subjectUserId,
      siteId: siteId === NO_SITE ? null : siteId,
      manualLocationLabel: siteId === NO_SITE ? placeName.trim() : null,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      projectId: siteId === NO_SITE ? null : projectId || null,
      reason: reason.trim(),
      latitude,
      longitude,
      accuracyMeters,
    });

    setSubmitting(false);

    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("detail.attendance.clockInError"));
      return;
    }

    setReason("");
    setOccurredAt("");
    setPlaceName("");
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

    const result = await AttendanceRepository.adminClockOut({
      subjectUserId,
      reason: reason.trim(),
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      latitude,
      longitude,
      accuracyMeters,
    });

    setSubmitting(false);

    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("detail.attendance.clockOutError"));
      return;
    }

    setReason("");
    load();
  };

  if (loading) return null;

  return (
    <Card title={t("detail.attendance.title")}>
      <HintText small>{t("detail.attendance.hint")}</HintText>

      <div style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-hover)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
        {t("detail.attendance.actorSubjectNotice", { actor: profile?.fullName ?? "", subject: subjectFullName })}
      </div>

      <ErrorText>{error}</ErrorText>

      {session ? (
        <>
          <HintText>{t("detail.attendance.clockedInSince", { time: formatTimeOnly(session.clockInAt, i18n.language) })}</HintText>
          {canClockOut ? (
            <>
              <Input label={t("detail.attendance.timeLabel")} name="adminClockOutTime" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} helperText={t("detail.attendance.timeHint")} disabled={submitting} />
              <Textarea label={t("detail.attendance.reasonLabel")} name="adminClockOutReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
              <Button onClick={handleClockOut} loading={submitting} disabled={!reason.trim()}>
                {t("detail.attendance.clockOutAction")}
              </Button>
            </>
          ) : null}
        </>
      ) : canClockIn ? (
        (
          <>
            <Select
              label={t("detail.attendance.siteLabel")}
              name="adminClockInSite"
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
              disabled={submitting}
              options={[...sites.map((site) => ({ value: site.id, label: site.name })), { value: NO_SITE, label: t("detail.attendance.noSiteOption") }]}
            />
            {siteId === NO_SITE ? (
              <Input label={t("detail.attendance.placeNameLabel")} name="adminClockInPlace" value={placeName} onChange={(event) => setPlaceName(event.target.value)} required disabled={submitting} />
            ) : null}
            <Input label={t("detail.attendance.timeLabel")} name="adminClockInTime" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} helperText={t("detail.attendance.timeHint")} disabled={submitting} />
            <Select
              label={t("detail.attendance.projectLabel")}
              name="adminClockInProject"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={submitting || projects.length === 0 || siteId === NO_SITE}
              options={[{ value: "", label: t("detail.attendance.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            />
            <Textarea label={t("detail.attendance.reasonLabel")} name="adminClockInReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
            <Button onClick={handleClockIn} loading={submitting} disabled={!siteId || !reason.trim() || (siteId === NO_SITE && !placeName.trim())}>
              {t("detail.attendance.clockInAction")}
            </Button>
          </>
        )
      ) : (
        <HintText>{t("detail.attendance.notClockedIn")}</HintText>
      )}
    </Card>
  );
}
