import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository, { type AttendanceSession } from "../../core/repositories/AttendanceRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import { getCurrentPosition } from "../../core/utils/geo";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";

// PROSM Time WP-06/§17/§37 - real Clock In/Out on the Dashboard
// (Employee Mobile Home is a later, dedicated mobile-UX pass - this is
// the same real functionality on the screen every employee already
// lands on). Location is a best-effort capture only: WP-06 never
// blocks a Clock In on a geolocation failure - GPS/geofence
// enforcement is WP-09's job, camera evidence is WP-08's.
export default function ClockInOutCard() {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [session, setSession] = useState<AttendanceSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const [sessionResult, sitesResult] = await Promise.all([AttendanceRepository.getCurrentSession(profile.id), SiteRepository.listAssignedSites(profile.id)]);
    setSession(sessionResult.success ? sessionResult.data ?? null : null);
    const assignedSites = sitesResult.success ? sitesResult.data ?? [] : [];
    setSites(assignedSites);
    setSiteId((current) => current || assignedSites[0]?.id || "");
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

  const handleClockIn = async () => {
    if (!siteId) return;
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
      // Best-effort only (see file header) - proceed without a
      // location sample rather than blocking the Clock In.
    }

    const result = await AttendanceRepository.clockIn({ siteId, projectId: projectId || null, latitude, longitude, accuracyMeters });

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("attendance.clockInError"));
      return;
    }

    load();
  };

  const handleClockOut = async () => {
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

    const result = await AttendanceRepository.clockOut({ latitude, longitude, accuracyMeters });

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("attendance.clockOutError"));
      return;
    }

    load();
  };

  return (
    <Card title={t("attendance.title")}>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}

      {session ? (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("attendance.clockedInSince", { time: new Date(session.clockInAt).toLocaleTimeString() })}</p>
          <Button onClick={handleClockOut} loading={submitting}>
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
          <Button onClick={handleClockIn} loading={submitting} disabled={!siteId}>
            {t("attendance.clockInAction")}
          </Button>
        </>
      )}
    </Card>
  );
}
