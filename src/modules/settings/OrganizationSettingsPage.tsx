import { Link, Navigate, useSearchParams } from "react-router-dom";
import { FEATURES } from "../../config/features";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";

import DepartmentsSettingsCard from "./DepartmentsSettingsCard";
import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
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

// A setting that has its own page, reached from the settings tree.
function SettingsLink({ to, title, hint }: { to: string; title: string; hint: string }) {
  return (
    <Card title={title}>
      <p style={{ margin: "0 0 var(--space-2)", color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{hint}</p>
      <Link to={to}>{title}</Link>
    </Card>
  );
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

  const showPayroll = allows("payroll") && (isOwner || hasPermission("payroll.manage_settings"));
  const showExternalPolicy = allows("kiosk") && (isOwner || hasPermission("external_labor.manage_policy"));
  const showAudit = allows("audit") && (isOwner || hasPermission("audit.view"));

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

      {/* 2026-11-09 B-05: grouped like the target settings tree (spec 25.5); a section shows only
          what the reader may change, and a setting that lives on its own page is linked from here. */}
      {isOwner || hasPermission("calendar.manage") || hasPermission("departments.manage") ? <SectionHeading>{t("sections.organization")}</SectionHeading> : null}
      {isOwner ? <PlanSettingsCard /> : null}
      {hasPermission("calendar.manage") ? <SettingsLink to="/calendar" title={t("links.calendar.title")} hint={t("links.calendar.hint")} /> : null}
      {/* 2026-11-09 Media Center: departments (announcements can be addressed to them) */}
      {hasPermission("departments.manage") ? <DepartmentsSettingsCard /> : null}

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

      {hasPermission("settings.session_policy") || isOwner || hasPermission("leave.manage_types") ? <SectionHeading>{t("sections.attendanceLeave")}</SectionHeading> : null}
      {hasPermission("settings.session_policy") ? <SessionPolicySettingsCard /> : null}
      {isOwner ? <OvertimePolicySettingsCard /> : null}
      {hasPermission("leave.manage_types") ? <LeaveTypesSettingsCard /> : null}

      {showPayroll || showExternalPolicy ? <SectionHeading>{t("sections.payroll")}</SectionHeading> : null}
      {showPayroll ? <SettingsLink to="/payroll/settings" title={t("links.payroll.title")} hint={t("links.payroll.hint")} /> : null}
      {showExternalPolicy ? <SettingsLink to="/workers/pay?view=policy" title={t("links.externalPolicy.title")} hint={t("links.externalPolicy.hint")} /> : null}

      {profile?.isRealOwner || showAudit || isOwner ? <SectionHeading>{t("sections.governance")}</SectionHeading> : null}
      {profile?.isRealOwner ? <SettingsLink to="/permissions" title={t("links.permissions.title")} hint={t("links.permissions.hint")} /> : null}
      {showAudit ? <SettingsLink to="/audit-log" title={t("links.auditLog.title")} hint={t("links.auditLog.hint")} /> : null}
      {isOwner ? <RetentionSettingsCard /> : null}
      {/* 2026-11-09: the API is on again (owner) - keys and webhooks live on their own page */}
      {FEATURES.integrations && isOwner && allows("integrations") ? <SettingsLink to="/integrations" title={t("links.integrations.title")} hint={t("links.integrations.hint")} /> : null}
    </PageShell>
  );
}
