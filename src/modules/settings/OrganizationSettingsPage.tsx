import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import NoSiteRadiusSettingsCard from "../sites/NoSiteRadiusSettingsCard";
import MockLocationSettingsCard from "./MockLocationSettingsCard";
import SessionPolicySettingsCard from "./SessionPolicySettingsCard";
import OvertimePolicySettingsCard from "./OvertimePolicySettingsCard";
import LeaveTypesSettingsCard from "./LeaveTypesSettingsCard";
import settingsHeaderImage from "../../assets/illustrations/settings.svg";
import SiteDefaultsSettingsCard from "./SiteDefaultsSettingsCard";
import SitePolicySettingsCard from "./SitePolicySettingsCard";
import PageBanner from "../../components/common/PageBanner";
import { APP_VERSION } from "../../core/appVersion";

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
      {hasPermission("settings.session_policy") ? <SessionPolicySettingsCard /> : null}
      {hasPermission("leave.manage_types") ? <LeaveTypesSettingsCard /> : null}
      {isOwner ? (
        <>
          <OvertimePolicySettingsCard />
          <NoSiteRadiusSettingsCard />
          <MockLocationSettingsCard />
          <SiteDefaultsSettingsCard />
        </>
      ) : null}
      <p style={{ margin: 0, fontSize: "var(--font-xs)", color: "var(--text-secondary)", textAlign: "center" }}>{t("common:versionLabel", { version: APP_VERSION })}</p>
    </PageShell>
  );
}
