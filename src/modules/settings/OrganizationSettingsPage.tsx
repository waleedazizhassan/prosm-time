import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";

import DepartmentsSettingsCard from "./DepartmentsSettingsCard";
import JobTitlesSettingsCard from "./JobTitlesSettingsCard";
import PenaltyBylawSettingsCard from "./PenaltyBylawSettingsCard";
import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import NoSiteRadiusSettingsCard from "../sites/NoSiteRadiusSettingsCard";
import NoSiteHoursSettingsCard from "../sites/NoSiteHoursSettingsCard";
import MockLocationSettingsCard from "./MockLocationSettingsCard";
import SessionPolicySettingsCard from "./SessionPolicySettingsCard";
import OvertimePolicySettingsCard from "./OvertimePolicySettingsCard";
import OvertimeLateTargetCard from "./OvertimeLateTargetCard";
import LeaveTypesSettingsCard from "./LeaveTypesSettingsCard";
import settingsHeaderImage from "../../assets/illustrations/settings.svg";
import SitePolicySettingsCard from "./SitePolicySettingsCard";
import PlanSettingsCard from "./PlanSettingsCard";
import RetentionSettingsCard from "./RetentionSettingsCard";
import ClockSuggestionCard from "./ClockSuggestionCard";
import PageBanner from "../../components/common/PageBanner";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import OwnershipTransferCard from "./OwnershipTransferCard";
import ConnectUsageCard from "./ConnectUsageCard";
import SecurityPolicyCard from "./SecurityPolicyCard";
import EmployeeCodesCard from "./EmployeeCodesCard";
import GovernanceModelCard from "./GovernanceModelCard";

// PROSM Time - § live UX review, user-directed: "a professional
// reorganization" - org-wide settings (today: the no-site geofence
// radius, previously stranded on the Sites page with no real home)
// now have a real, dedicated, Owner-only home. Deliberately does NOT
// move the organization logo here - HeaderOrganizationCard.tsx is
// already the established, deliberate pattern for that (ported from
// PROSM Platform's own Header/OrganizationCard, replaced bulkier
// Dashboard cards per an earlier pass) - a genuinely good existing
// home, not something misplaced.
type SettingsTab = "governance" | "security" | "sites" | "attendance" | "people" | "plan";

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
  // older links: "outside" lives in Attendance now, "other" was security and the plan
  const OLD_TABS: Record<string, SettingsTab> = { outside: "attendance", other: "security" };
  const asked = location.hash === "#plan" ? "plan" : searchParams.get("tab");
  const tab = (asked ? OLD_TABS[asked] ?? asked : null) as SettingsTab | null;
  const chooseTab = (next: SettingsTab) => navigate(`/settings?tab=${next}`, { replace: true });

  // Owner 2026-10-20 ("move every setting, the sites' too, to the Settings
  // page"): each site's rules are chosen here from a site list - managers
  // see the sites they manage - and the organisation-wide settings follow
  // for the Owner.
  if (!isOwner && !hasPermission("sites.manage") && !hasPermission("hr.manage")) {
    return <Navigate to="/dashboard" replace />;
  }

  const showDepartments = allows("departments") && hasPermission("departments.manage");
  const showPeople = isOwner || hasPermission("hr.manage") || hasPermission("leave.manage_types") || showDepartments;
  const showAttendance = isOwner || hasPermission("settings.session_policy");

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
  // Owner 2026-11-16: one place per setting, no card twice - governance and security first and clear, then the
  // sites, attendance, human resources, and the plan with what it is used for.
  const tabs: SettingsTab[] = [
    ...(isOwner ? (["governance", "security"] as SettingsTab[]) : []),
    "sites",
    ...(showAttendance ? (["attendance"] as SettingsTab[]) : []),
    ...(showPeople ? (["people"] as SettingsTab[]) : []),
    ...(isOwner ? (["plan"] as SettingsTab[]) : []),
  ];
  const active: SettingsTab = tab && tabs.includes(tab) ? tab : tabs[0];

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

      {active === "governance" ? <GovernanceModelCard /> : null}

      {active === "security" ? (
        <>
          {/* identity confirmation / two-step verification for sensitive actions */}
          <SecurityPolicyCard />
          {/* governance phase E: the only way the owner changes */}
          {profile?.isRealOwner ? <OwnershipTransferCard /> : null}
          {allows("retention") ? <RetentionSettingsCard /> : null}
        </>
      ) : null}

      {active === "sites" ? (
        <>
          <SitePolicySettingsCard />
          {isOwner && allows("clock_suggestion") ? <ClockSuggestionCard /> : null}
        </>
      ) : null}

      {active === "attendance" ? (
        <>
          {hasPermission("settings.session_policy") ? <SessionPolicySettingsCard /> : null}
          {isOwner ? <NoSiteRadiusSettingsCard /> : null}
          {isOwner ? <NoSiteHoursSettingsCard /> : null}
          {isOwner ? <OvertimeLateTargetCard hasPayroll={allows("payroll")} hasAllowances={allows("allowances")} /> : null}
          {isOwner ? <OvertimePolicySettingsCard /> : null}
          {isOwner ? <MockLocationSettingsCard /> : null}
        </>
      ) : null}

      {active === "people" ? (
        <>
          {showDepartments ? <DepartmentsSettingsCard /> : null}
          {isOwner || hasPermission("hr.manage") ? <JobTitlesSettingsCard /> : null}
          {isOwner ? <EmployeeCodesCard /> : null}
          {hasPermission("leave.manage_types") ? <LeaveTypesSettingsCard /> : null}
          {(isOwner || hasPermission("hr.manage")) && allows("penalties") ? <PenaltyBylawSettingsCard /> : null}
        </>
      ) : null}

      {active === "plan" ? (
        <>
          <PlanSettingsCard />
          {/* what calls and meetings carried, direct vs relay */}
          <ConnectUsageCard />
        </>
      ) : null}
    </PageShell>
  );
}
