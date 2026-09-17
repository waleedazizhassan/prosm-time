import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import checkInRemoteIllustration from "../../assets/illustration-checkin-remote.png";
import kioskHeaderImage from "../../assets/illustration-kiosk-header.png";

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
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    SiteRepository.listSites().then((result) => {
      setSites(result.success ? (result.data ?? []).filter((site) => site.kioskMode !== "personal_device_only") : []);
      setLoading(false);
    });
  }, []);

  return (
    <PageShell title="">
      <img
        src={kioskHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "4.9cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

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
        {t("launcher.explainer")}
      </p>
    </PageShell>
  );
}
