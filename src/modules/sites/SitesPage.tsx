import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, Link } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import Table, { type TableColumn } from "../../components/common/Table";
import SiteFormModal from "./SiteFormModal";
import ErrorText from "../../components/common/ErrorText";
import sitesBanner from "../../assets/illustration-sites-banner.jpg";

// § live UX review, user-directed - "give it a real proper home, but
// keep it reachable from here too." The editable form itself now
// lives on the new Settings page (OrganizationSettingsPage.tsx) - this
// is a read-only summary + link, not a second copy of the same
// editable state.
function NoSiteRadiusSummary() {
  const { t } = useTranslation("sites");
  const [radiusMeters, setRadiusMeters] = useState<number | null>(null);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setRadiusMeters(result.data.noSiteAllowedRadiusMeters);
    });
  }, []);

  if (radiusMeters === null) return null;

  return (
    <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
      {t("noSiteRadius.summaryLine", { meters: radiusMeters })} <Link to="/settings">{t("noSiteRadius.manageLink")}</Link>
    </p>
  );
}

// PROSM Time Implementation Master File V3.0, WP-05/§13/§37 - "Site
// Management + Map/Geofence." The site list itself is RLS-scoped to
// sites the caller is assigned to (or all, for the Owner); Add Site
// is Owner-only (create_prosm_time_site rejects non-owners
// server-side, 20260902090000) - a Manager may configure a site she
// manages, but creating a new one is an organizational decision.
export default function SitesPage() {
  const { t } = useTranslation("sites");
  const navigate = useNavigate();
  const { hasPermission, profile } = useAuth();

  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const result = await SiteRepository.listSites();
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      setSites([]);
      setLoading(false);
      return;
    }
    setSites(result.data ?? []);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("sites.manage")) {
    return <Navigate to="/dashboard" replace />;
  }

  const columns: TableColumn<Site>[] = [
    { key: "name", header: t("columns.name"), render: (site) => site.name },
    { key: "address", header: t("columns.address"), render: (site) => site.displayAddress ?? "—" },
    { key: "kioskMode", header: t("columns.kioskMode"), render: (site) => t(`kioskMode.${site.kioskMode}`) },
    {
      key: "status",
      header: t("columns.status"),
      render: (site) => <StatusBadge status={site.isActive ? "active" : "neutral"}>{site.isActive ? t("status.active") : t("status.inactive")}</StatusBadge>,
    },
  ];

  return (
    <PageShell
      title={t("title")}
      subtitle={t("subtitle")}
      bannerSrc={sitesBanner}
      actions={profile?.isOwner ? <Button onClick={() => setCreateOpen(true)}>{t("addAction")}</Button> : undefined}
    >
      {profile?.isOwner ? <NoSiteRadiusSummary /> : null}

      <ErrorText>{loadError}</ErrorText>

      <Table columns={columns} data={sites} getRowId={(site) => site.id} loading={loading} emptyMessage="—" onRowClick={(site) => navigate(`/sites/${site.id}`)} />

      <SiteFormModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          load();
        }}
      />
    </PageShell>
  );
}
