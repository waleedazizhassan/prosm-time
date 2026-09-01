import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site, type SiteAssignment } from "../../core/repositories/SiteRepository";
import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
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

  const canManageSites = hasPermission("sites.manage");
  const canManageProjects = hasPermission("projects.manage");

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setLoadError("");

    const [siteResult, assignmentsResult, projectsResult] = await Promise.all([
      SiteRepository.getSite(siteId),
      SiteRepository.listSiteAssignments(siteId),
      ProjectRepository.listProjectsForSite(siteId),
    ]);

    if (!siteResult.success || !siteResult.data) {
      setLoadError(siteResult.message ?? t("detail.loadError"));
      setLoading(false);
      return;
    }

    setSite(siteResult.data);
    setAssignments(assignmentsResult.success ? assignmentsResult.data ?? [] : []);
    setProjects(projectsResult.success ? projectsResult.data ?? [] : []);
    setLoading(false);
  }, [siteId, t]);

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
        <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{loadError}</p>
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
