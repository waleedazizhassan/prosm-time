import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import Table, { type TableColumn } from "../../components/common/Table";
import SiteFormModal from "./SiteFormModal";

// PROSM Time Implementation Master File V3.0, WP-05/§13/§37 - "Site
// Management + Map/Geofence." Real org-scoped site list (RLS) with an
// Add action gated on the real 'sites.manage' permission - the RPCs
// themselves re-check this server-side, this page only hides the
// button.
export default function SitesPage() {
  const { t } = useTranslation("sites");
  const navigate = useNavigate();
  const { hasPermission } = useAuth();

  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const result = await SiteRepository.listSites();
    if (!result.success) {
      setLoadError(result.message ?? t("loadError"));
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
    <PageShell title={t("title")} subtitle={t("subtitle")} actions={<Button onClick={() => setCreateOpen(true)}>{t("addAction")}</Button>}>
      {loadError ? <p style={{ color: "var(--brand-danger)" }}>{loadError}</p> : null}

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
