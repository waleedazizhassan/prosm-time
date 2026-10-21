import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";

import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import checkInRemoteIllustration from "../../assets/illustration-checkin-remote.webp";
import kioskHeaderImage from "../../assets/illustrations/kiosk.svg";
import PageBanner from "../../components/common/PageBanner";

// PROSM Time - § user-directed: bring Kiosk Mode back into the
// sidebar (it was reachable only by a direct /kiosk/:siteId URL,
// invisible from navigation). This launcher lists sites where kiosk
// mode is actually usable (kioskMode <> "personal_device_only") and
// links each to its own real kiosk screen - open to every
// authenticated member (kiosk itself is a shared-device flow whose
// real identity check is the PIN, not who launched it, matching
// KioskPage's own established posture).
export default function KioskLauncherPage() {
  const { t } = useTranslation("kiosk");
  const { profile } = useAuth();
  const allowed = Boolean(profile?.isOwner) || profile?.roleKey === "manager";
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

  // Owner 2026-10-19: the workers' kiosk is run by the Owner, or by a Manager at a site they manage.
  useEffect(() => {
    if (!allowed || !profile) return;
    Promise.all([SiteRepository.listSites(), profile.isOwner ? null : SiteRepository.listManagedSiteIds(profile.id)]).then(([result, managed]) => {
      const managedIds = managed && managed.success ? new Set(managed.data ?? []) : null;
      const usable = (result.success ? result.data ?? [] : []).filter((site) => site.kioskMode !== "personal_device_only");
      setSites(profile.isOwner ? usable : usable.filter((site) => managedIds?.has(site.id)));
      setLoading(false);
    });
  }, [allowed, profile]);

  if (!allowed) return <Navigate to="/dashboard" replace />;

  return (
    <PageShell title="">
      <PageBanner pageId="kiosk" illustration={kioskHeaderImage} />

      <Card title={t("launcher.title")}>
        {loading ? (
          <LoadingState />
        ) : sites.length === 0 ? (
          <EmptyState message={t("launcher.empty")} illustrationSrc={checkInRemoteIllustration} />
        ) : (
          sites.map((site) => (
            <ListRow key={site.id}>
              <span style={{ fontSize: "var(--font-sm)" }}>{site.name}</span>
              <Link to={`/kiosk/${site.id}`}>
                <Button size="sm">{t("launcher.openAction")}</Button>
              </Link>
            </ListRow>
          ))
        )}
      </Card>

      <p style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)", lineHeight: 1.6, margin: "var(--space-3) var(--space-2) 0" }}>
        {t("launcher.explainerWorkers")}
      </p>
    </PageShell>
  );
}
