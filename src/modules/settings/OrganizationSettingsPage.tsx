import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";

import DepartmentsSettingsCard from "./DepartmentsSettingsCard";
import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
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
type SettingsTab = "sites" | "outside" | "people" | "other";

export default function OrganizationSettingsPage() {
  const { t } = useTranslation("settings");
  const { profile, hasPermission } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const isOwner = Boolean(profile?.isOwner);
  // owner 2026-10-28 ("from a site, 'open the site's rules' sent me to all the
  // settings"): opened for one site, the page shows that site's rules only
  const [searchParams] = useSearchParams();
  const focusedSite = searchParams.get("site");
  // the open part: ?tab=..., and a link to "#plan" opens the plan's part
  const location = useLocation();
  const navigate = useNavigate();
  const tab = (location.hash === "#plan" ? "other" : searchParams.get("tab") ?? "sites") as SettingsTab;
  const chooseTab = (next: SettingsTab) => navigate(next === "sites" ? "/settings" : `/settings?tab=${next}`, { replace: true });

  // Owner 2026-10-20 ("move every setting, the sites' too, to the Settings
  // page"): each site's rules are chosen here from a site list - managers
  // see the sites they manage - and the organisation-wide settings follow
  // for the Owner.
  if (!isOwner && !hasPermission("sites.manage")) {
    return <Navigate to="/dashboard" replace />;
  }

  const showDepartments = allows("departments") && hasPermission("departments.manage");
  const showPeople = isOwner || hasPermission("settings.session_policy") || hasPermission("leave.manage_types") || showDepartments;
  const showOther = isOwner;

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

  // Owner 2026-11-10: the settings as a tree - the sites (each site's every setting), outside the
  // sites, people, and everything else - one part at a time. Pages that have their own place in the
  // menu (calendar, permissions, action log, API, payroll settings) are not repeated here.
  const tabs: SettingsTab[] = ["sites", ...(isOwner ? (["outside"] as SettingsTab[]) : []),
    ...(showPeople ? (["people"] as SettingsTab[]) : []), ...(showOther ? (["other"] as SettingsTab[]) : [])];
  const active: SettingsTab = tabs.includes(tab) ? tab : "sites";

  return (
    <PageShell title="">
      <PageBanner pageId="settings" illustration={settingsHeaderImage} />

      <div role="tablist" aria-label={t("tabs.label")} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        {tabs.map((key) => (
          <Button key={key} role="tab" aria-selected={active === key} variant={active === key ? "primary" : "ghost"} onClick={() => chooseTab(key)}>
            {t(`tabs.${key}`)}
          </Button>
        ))}
      </div>

      {active === "sites" ? (
        <>
          <SitePolicySettingsCard />
          {isOwner ? <SiteDefaultsSettingsCard /> : null}
          {isOwner && allows("clock_suggestion") ? <ClockSuggestionCard /> : null}
        </>
      ) : null}

      {active === "outside" ? <NoSiteRadiusSettingsCard /> : null}

      {active === "people" ? (
        <>
          {hasPermission("settings.session_policy") ? <SessionPolicySettingsCard /> : null}
          {isOwner ? <OvertimePolicySettingsCard /> : null}
          {hasPermission("leave.manage_types") ? <LeaveTypesSettingsCard /> : null}
          {/* 2026-11-09 Media Center: departments (announcements can be addressed to them) */}
          {showDepartments ? <DepartmentsSettingsCard /> : null}
        </>
      ) : null}

      {active === "other" ? (
        <>
          {isOwner ? <PlanSettingsCard /> : null}
          {isOwner ? <MockLocationSettingsCard /> : null}
          {isOwner && allows("retention") ? <RetentionSettingsCard /> : null}
        </>
      ) : null}
    </PageShell>
  );
}
