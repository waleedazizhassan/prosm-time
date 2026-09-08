import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import NoSiteRadiusSettingsCard from "../sites/NoSiteRadiusSettingsCard";
import SiteDefaultsSettingsCard from "./SiteDefaultsSettingsCard";
import SitePolicySettingsCard from "./SitePolicySettingsCard";
import IntegrationsSettingsCard from "./IntegrationsSettingsCard";
import QuickBooksSettingsCard from "./QuickBooksSettingsCard";

// PROSM Time - § live UX review, user-directed: "a professional
// reorganization" - org-wide settings (today: the no-site geofence
// radius, previously stranded on the Sites page with no real home)
// now have a real, dedicated, Owner-only home. Deliberately does NOT
// move the organization logo here - HeaderOrganizationCard.tsx is
// already the established, deliberate pattern for that (ported from
// PROSM Platform's own Header/OrganizationCard, replaced bulkier
// Dashboard cards per an earlier pass) - a genuinely good existing
// home, not something misplaced.
export default function OrganizationSettingsPage() {
  const { t } = useTranslation("settings");
  const { profile } = useAuth();

  if (!profile?.isOwner) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <NoSiteRadiusSettingsCard />
      <SiteDefaultsSettingsCard />
      <SitePolicySettingsCard />
      <IntegrationsSettingsCard />
      <QuickBooksSettingsCard />
    </PageShell>
  );
}
