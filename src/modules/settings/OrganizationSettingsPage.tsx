import { Link, Navigate, useSearchParams } from "react-router-dom";
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
import PlanSettingsCard from "./PlanSettingsCard";
import RetentionSettingsCard from "./RetentionSettingsCard";
import ClockSuggestionCard from "./ClockSuggestionCard";
import PageBanner from "../../components/common/PageBanner";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";

// PROSM Time - § live UX review, user-directed: "a professional
// reorganization" - org-wide settings (today: the no-site geofence
// radius, previously stranded on the Sites page with no real home)
// now have a real, dedicated, Owner-only home. Deliberately does NOT
// move the organization logo here - HeaderOrganizationCard.tsx is
// already the established, deliberate pattern for that (ported from
// PROSM Platform's own Header/OrganizationCard, replaced bulkier
// Dashboard cards per an earlier pass) - a genuinely good existing
// home, not something misplaced.
function SectionHeading({ children }: { children: string }) {
  return <h2 style={{ margin: "var(--space-2) 0 calc(var(--space-2) * -1)", fontSize: "var(--font-lg)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{children}</h2>;
}

export default function OrganizationSettingsPage() {
  const { t } = useTranslation("settings");
  const { profile, hasPermission } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const isOwner = Boolean(profile?.isOwner);
  // owner 2026-10-28 ("from a site, 'open the site's rules' sent me to all the
  // settings"): opened for one site, the page shows that site's rules only
  const [searchParams] = useSearchParams();
  const focusedSite = searchParams.get("site");

  // Owner 2026-10-20 ("move every setting, the sites' too, to the Settings
  // page"): each site's rules are chosen here from a site list - managers
  // see the sites they manage - and the organisation-wide settings follow
  // for the Owner.
  if (!isOwner && !hasPermission("sites.manage")) {
    return <Navigate to="/dashboard" replace />;
  }

  if (focusedSite) {
    return (
      <PageShell title="">
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", fontSize: "var(--font-sm)" }}>
          <Link to={`/sites/${focusedSite}`}>{t("siteFocus.backToSite")}</Link>
          <span aria-hidden="true">·</span>
          <Link to="/settings">{t("siteFocus.allSettings")}</Link>
        </div>
        <SitePolicySettingsCard key={focusedSite} />
      </PageShell>
    );
  }

  return (
    <PageShell title="">
      <PageBanner pageId="settings" illustration={settingsHeaderImage} />

      {/* Owner 2026-11-02: grouped, the plan first and apart from the sites' rules. */}
      {isOwner ? (
        <>
          <SectionHeading>{t("sections.subscription")}</SectionHeading>
          <PlanSettingsCard />
        </>
      ) : null}

      <SectionHeading>{t("sections.sites")}</SectionHeading>
      <SitePolicySettingsCard />
      {isOwner ? (
        <>
          <SiteDefaultsSettingsCard />
          <NoSiteRadiusSettingsCard />
          <MockLocationSettingsCard />
          {allows("clock_suggestion") ? <ClockSuggestionCard /> : null}
        </>
      ) : null}

      {hasPermission("settings.session_policy") || isOwner ? <SectionHeading>{t("sections.time")}</SectionHeading> : null}
      {hasPermission("settings.session_policy") ? <SessionPolicySettingsCard /> : null}
      {isOwner ? <OvertimePolicySettingsCard /> : null}

      {hasPermission("leave.manage_types") ? (
        <>
          <SectionHeading>{t("sections.leave")}</SectionHeading>
          <LeaveTypesSettingsCard />
        </>
      ) : null}

      {isOwner ? (
        <>
          <SectionHeading>{t("sections.privacy")}</SectionHeading>
          <RetentionSettingsCard />
        </>
      ) : null}
    </PageShell>
  );
}
