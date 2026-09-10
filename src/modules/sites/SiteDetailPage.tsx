import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site, type SiteAssignment } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";
import SiteWorkerRepository, { type SiteWorker } from "../../core/repositories/SiteWorkerRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import Table, { type TableColumn } from "../../components/common/Table";
import SiteFormModal from "./SiteFormModal";
import AssignSiteMemberModal from "./AssignSiteMemberModal";
import ProjectFormModal from "./ProjectFormModal";
import ProjectAssignmentsModal from "./ProjectAssignmentsModal";

// PROSM Time WP-05/§13/§14 - Site detail: full configuration, assigned
// employees/managers, and the site's projects. Project management is
// nested here rather than a separate top-level screen because every
// project belongs to exactly one site (Site -> Project -> Employee ->
// Assignment, §14) - there is no cross-site project concept to manage
// independently.
export default function SiteDetailPage() {
  const { t } = useTranslation("sites");
  const { siteId } = useParams<{ siteId: string }>();
  const { hasPermission } = useAuth();

  const [site, setSite] = useState<Site | null>(null);
  const [assignments, setAssignments] = useState<SiteAssignment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [projectFormState, setProjectFormState] = useState<{ open: boolean; project?: Project }>({ open: false });
  const [projectAssignmentsFor, setProjectAssignmentsFor] = useState<Project | null>(null);

  const [siteWorkers, setSiteWorkers] = useState<SiteWorker[]>([]);
  const [workerName, setWorkerName] = useState("");
  const [workerNumber, setWorkerNumber] = useState("");
  const [workerContractorName, setWorkerContractorName] = useState("");
  const [workerSubmitting, setWorkerSubmitting] = useState(false);
  const [workerError, setWorkerError] = useState("");
  const [deactivatingWorkerId, setDeactivatingWorkerId] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<{ workerId: string; reason: string } | null>(null);
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);

  const canManageSites = hasPermission("sites.manage");
  const canManageProjects = hasPermission("projects.manage");

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setLoadError("");

    const [siteResult, assignmentsResult, projectsResult, workersResult] = await Promise.all([
      SiteRepository.getSite(siteId),
      SiteRepository.listSiteAssignments(siteId),
      ProjectRepository.listProjectsForSite(siteId),
      SiteWorkerRepository.list(siteId),
    ]);

    if (!siteResult.success || !siteResult.data) {
      setLoadError(humanizeBackendError(siteResult.message, t) ?? t("detail.loadError"));
      setLoading(false);
      return;
    }

    setSite(siteResult.data);
    setAssignments(assignmentsResult.success ? assignmentsResult.data ?? [] : []);
    setProjects(projectsResult.success ? projectsResult.data ?? [] : []);
    setSiteWorkers(workersResult.success ? workersResult.data ?? [] : []);
    setLoading(false);
  }, [siteId, t]);

  const handleAddWorker = async () => {
    if (!siteId || !workerName.trim() || workerNumber.length !== 6) return;
    setWorkerSubmitting(true);
    setWorkerError("");
    const result = await SiteWorkerRepository.create(siteId, workerName.trim(), workerNumber, workerContractorName.trim() || null);
    setWorkerSubmitting(false);
    if (!result.success) {
      setWorkerError(humanizeBackendError(result.message, t) ?? t("detail.workforceAddError"));
      return;
    }
    setWorkerName("");
    setWorkerNumber("");
    setWorkerContractorName("");
    load();
  };

  const handleDeactivateWorker = async (workerId: string) => {
    setDeactivatingWorkerId(workerId);
    const result = await SiteWorkerRepository.deactivate(workerId);
    setDeactivatingWorkerId(null);
    if (!result.success) {
      setWorkerError(humanizeBackendError(result.message, t) ?? t("detail.workforceDeactivateError"));
      return;
    }
    load();
  };

  // § real gap fix, 14-point live-audit - external workers had no
  // admin-override path for a missed checkout, unlike the already-real
  // one for regular employees (AdminAttendanceCard). Mirrors that
  // component's own inline-reason-textarea pattern rather than a raw
  // browser prompt, for the same reason it does: a native prompt isn't
  // theme/RTL-aware and reads as foreign inside the app.
  const handleSubmitOverride = async () => {
    if (!overrideDraft || !overrideDraft.reason.trim()) return;
    setOverrideSubmitting(true);
    const result = await SiteWorkerRepository.adminClockOut(overrideDraft.workerId, overrideDraft.reason.trim());
    setOverrideSubmitting(false);
    if (!result.success) {
      setWorkerError(humanizeBackendError(result.message, t) ?? t("detail.workforceOverrideError"));
      return;
    }
    setOverrideDraft(null);
    load();
  };

  useEffect(() => {
    load();
  }, [load]);

  if (!canManageSites) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleRemoveAssignment = async (userId: string) => {
    if (!siteId) return;
    await SiteRepository.removeSiteAssignment(siteId, userId);
    load();
  };

  const projectColumns: TableColumn<Project>[] = [
    { key: "name", header: t("form.nameLabel"), render: (project) => project.name },
    { key: "code", header: t("detail.projectForm.codeLabel"), render: (project) => project.code ?? "—" },
    {
      key: "status",
      header: t("columns.status"),
      render: (project) => <StatusBadge status={project.isActive ? "active" : "neutral"}>{project.isActive ? t("status.active") : t("status.inactive")}</StatusBadge>,
    },
    {
      key: "actions",
      header: "",
      render: (project) => (
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          {canManageProjects ? (
            <Button variant="ghost" size="xs" onClick={() => setProjectFormState({ open: true, project })}>
              {t("detail.editAction")}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => setProjectAssignmentsFor(project)}>
            {t("detail.manageProjectAssignmentsAction")}
          </Button>
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <PageShell title={t("title")}>
        <LoadingState fullHeight />
      </PageShell>
    );
  }
  if (loadError || !site) {
    return (
      <PageShell title={t("title")}>
        <ErrorText>{loadError}</ErrorText>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={site.name}
      subtitle={site.displayAddress ?? undefined}
      actions={
        <>
          {site.kioskMode !== "personal_device_only" ? (
            <Link to={`/kiosk/${site.id}`}>
              <Button variant="ghost">{t("detail.launchKioskAction")}</Button>
            </Link>
          ) : null}
          {canManageSites ? <Button onClick={() => setEditOpen(true)}>{t("detail.editAction")}</Button> : null}
        </>
      }
    >
      <Link to="/sites" style={{ color: "var(--text-link)", fontSize: "var(--font-sm)" }}>
        {t("detail.backToList")}
      </Link>

      <Card title={t("detail.assignmentsTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.assignmentsHint")}</p>

        {canManageSites ? (
          <Button variant="ghost" size="sm" onClick={() => setAssignOpen(true)}>
            {t("detail.assignAction")}
          </Button>
        ) : null}

        {assignments.length === 0 ? (
          <EmptyState message={t("detail.noAssignments")} />
        ) : (
          assignments.map((assignment) => (
            <ListRow key={assignment.id}>
              <div>
                <div style={{ color: "var(--text-primary)", fontSize: "var(--font-sm)" }}>{assignment.userFullName}</div>
                <StatusBadge status="neutral">{t(`detail.roleAtSite.${assignment.roleAtSite}`)}</StatusBadge>
              </div>
              {canManageSites ? (
                <Button variant="ghost" size="xs" onClick={() => handleRemoveAssignment(assignment.userId)}>
                  {t("detail.removeAssignmentAction")}
                </Button>
              ) : null}
            </ListRow>
          ))
        )}
      </Card>

      <Card title={t("detail.projectsTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.projectsHint")}</p>

        {canManageProjects ? (
          <Button variant="ghost" size="sm" onClick={() => setProjectFormState({ open: true })}>
            {t("detail.addProjectAction")}
          </Button>
        ) : null}

        <Table columns={projectColumns} data={projects} getRowId={(project) => project.id} loading={false} emptyMessage={t("detail.noProjects")} />
      </Card>

      <Card title={t("detail.workforceTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.workforceHint")}</p>

        {siteWorkers.length === 0 ? (
          <EmptyState message={t("detail.noWorkforce")} />
        ) : (
          siteWorkers
            .filter((worker) => worker.status === "active")
            .map((worker) => (
              <div key={worker.id}>
                <ListRow>
                  <div>
                    <div style={{ color: "var(--text-primary)", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)" }}>{worker.fullName}</div>
                    <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", fontFamily: "monospace", letterSpacing: "0.1em" }}>{worker.workerNumber}</div>
                    {worker.contractorName ? <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)" }}>{worker.contractorName}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                    {worker.hasOpenSession ? (
                      <>
                        <StatusBadge status="active">{t("detail.workforceOpenSessionBadge")}</StatusBadge>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setOverrideDraft({ workerId: worker.id, reason: "" })}
                        >
                          {t("detail.workforceOverrideAction")}
                        </Button>
                      </>
                    ) : null}
                    <Button variant="ghost" size="xs" onClick={() => handleDeactivateWorker(worker.id)} loading={deactivatingWorkerId === worker.id}>
                      {t("detail.deactivateWorkerAction")}
                    </Button>
                  </div>
                </ListRow>
                {overrideDraft?.workerId === worker.id ? (
                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap", padding: "0 var(--space-3) var(--space-3)" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <Textarea
                        label={t("detail.workforceOverrideReasonLabel")}
                        name="workforceOverrideReason"
                        value={overrideDraft.reason}
                        onChange={(event) => setOverrideDraft({ workerId: worker.id, reason: event.target.value })}
                        disabled={overrideSubmitting}
                      />
                    </div>
                    <Button variant="ghost" size="xs" onClick={() => setOverrideDraft(null)} disabled={overrideSubmitting}>
                      {t("detail.cancelAction")}
                    </Button>
                    <Button size="xs" onClick={handleSubmitOverride} loading={overrideSubmitting} disabled={!overrideDraft.reason.trim()}>
                      {t("detail.workforceOverrideConfirmAction")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <div style={{ minWidth: 180 }}>
            <Input label={t("detail.workerNameLabel")} name="workerName" value={workerName} onChange={(event) => setWorkerName(event.target.value)} disabled={workerSubmitting} />
          </div>
          <div style={{ width: 140 }}>
            <Input
              label={t("detail.workerNumberLabel")}
              name="workerNumber"
              value={workerNumber}
              onChange={(event) => setWorkerNumber(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              placeholder="123456"
              disabled={workerSubmitting}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <Input
              label={t("detail.workerContractorNameLabel")}
              name="workerContractorName"
              value={workerContractorName}
              onChange={(event) => setWorkerContractorName(event.target.value)}
              disabled={workerSubmitting}
            />
          </div>
          <Button onClick={handleAddWorker} loading={workerSubmitting} disabled={!workerName.trim() || workerNumber.length !== 6}>
            {t("detail.addWorkerAction")}
          </Button>
        </div>
        <ErrorText>{workerError}</ErrorText>
      </Card>

      <SiteFormModal
        key={site.id}
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        site={site}
        onSaved={() => {
          setEditOpen(false);
          load();
        }}
      />

      <AssignSiteMemberModal
        isOpen={assignOpen}
        onClose={() => setAssignOpen(false)}
        siteId={site.id}
        onAssigned={() => {
          setAssignOpen(false);
          load();
        }}
      />

      <ProjectFormModal
        key={projectFormState.project?.id ?? "create-project"}
        isOpen={projectFormState.open}
        onClose={() => setProjectFormState({ open: false })}
        siteId={site.id}
        project={projectFormState.project}
        onSaved={() => {
          setProjectFormState({ open: false });
          load();
        }}
      />

      {projectAssignmentsFor ? (
        <ProjectAssignmentsModal isOpen={Boolean(projectAssignmentsFor)} onClose={() => setProjectAssignmentsFor(null)} project={projectAssignmentsFor} />
      ) : null}
    </PageShell>
  );
}
