import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import NoSiteRadiusSettingsCard from "../sites/NoSiteRadiusSettingsCard";
import MockLocationSettingsCard from "./MockLocationSettingsCard";
import settingsHeaderImage from "../../assets/illustrations/settings.svg";
import SiteDefaultsSettingsCard from "./SiteDefaultsSettingsCard";
import SitePolicySettingsCard from "./SitePolicySettingsCard";
import PageBanner from "../../components/common/PageBanner";
// PayrollIntegrationCard intentionally not rendered below - § user-
// directed, 2026-09-13: "hide it, not delete it, until we know how
// we'll actually use it." Component and its own QuickBooks RPCs are
// untouched - uncomment the import and the render below to bring it
// back.
// import PayrollIntegrationCard from "./PayrollIntegrationCard";

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
  const { profile, hasPermission } = useAuth();
  const isOwner = Boolean(profile?.isOwner);

  // Owner 2026-10-20 ("move every setting, the sites' too, to the Settings
  // page"): each site's rules are chosen here from a site list - managers
  // see the sites they manage - and the organisation-wide settings follow
  // for the Owner.
  if (!isOwner && !hasPermission("sites.manage")) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageShell title="">
      <PageBanner pageId="settings" illustration={settingsHeaderImage} />

      <SitePolicySettingsCard />
      {isOwner ? (
        <>
          <NoSiteRadiusSettingsCard />
          <MockLocationSettingsCard />
          <SiteDefaultsSettingsCard />
        </>
      ) : null}
      {/* <PayrollIntegrationCard /> - see the hidden import's own comment above */}
    </PageShell>
  );
}
