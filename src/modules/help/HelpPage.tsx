import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import helpHeaderImage from "../../assets/illustrations/help.svg";
import PageBanner from "../../components/common/PageBanner";
import LegalLinks from "../legal/LegalLinks";
import HintText from "../../components/common/HintText";
import Button from "../../components/common/Button";
import { useState } from "react";
import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures, { type PlanFeature } from "../../core/hooks/usePlanFeatures";

// PROSM Time WP-21/§32 - "A dedicated Help area must exist, providing:
// product help, basic usage guidance, FAQ where implemented, support
// contact, information contact." Both real, official addresses are
// shown - info@prosm.net for general/information contact, and
// support@prosm.net (added per explicit user-directed request) as the
// dedicated support contact.
type Audience = "all" | "manager" | "admin" | "payroll";
type Guide = { id: string; audience: Audience; feature?: PlanFeature };

// Owner 2026-11-11: "Help shows each role what suits its role" - an employee sees what they use, a
// manager also what they manage, the owner and personnel managers everything; plan features that are
// off are left out. "Show all topics" opens the rest.
const GUIDES: Guide[] = [
  { id: "gettingStarted", audience: "all" },
  { id: "employeeHome", audience: "all" },
  { id: "attendance", audience: "all" },
  { id: "offline", audience: "all" },
  { id: "walkInGeofence", audience: "all" },
  { id: "siteChange", audience: "all" },
  { id: "locationChecks", audience: "all" },
  { id: "sos", audience: "all", feature: "sos" },
  { id: "notifications", audience: "all" },
  { id: "timesheets", audience: "all" },
  { id: "longSessions", audience: "all" },
  { id: "leavingSite", audience: "all" },
  { id: "liveCheck", audience: "all" },
  { id: "allowances", audience: "all", feature: "allowances" },
  { id: "leave", audience: "all", feature: "leave" },
  { id: "workCalendar", audience: "all" },
  { id: "schedule", audience: "all" },
  // 2026-11-11 HR suite: the person's own file, documents, warnings and incentives
  { id: "myFile", audience: "all" },
  { id: "myDocuments", audience: "all", feature: "documents" },
  { id: "myPenalties", audience: "all", feature: "penalties" },
  { id: "payslips", audience: "all", feature: "payroll" },
  { id: "announcements", audience: "all", feature: "announcements" },
  { id: "phoneNotifications", audience: "all" },
  { id: "getTheApp", audience: "all" },
  { id: "updates", audience: "all" },
  { id: "headerTools", audience: "all" },
  { id: "radio", audience: "all" },
  { id: "exceptions", audience: "manager" },
  { id: "overtimeControl", audience: "manager" },
  { id: "managerDashboard", audience: "manager" },
  { id: "liveMap", audience: "manager" },
  { id: "peopleAndPhotos", audience: "manager" },
  { id: "personPage", audience: "manager" },
  { id: "penaltiesManager", audience: "manager", feature: "penalties" },
  { id: "kiosk", audience: "manager", feature: "kiosk" },
  { id: "workers", audience: "manager", feature: "kiosk" },
  { id: "sites", audience: "manager" },
  { id: "reportsCenter", audience: "manager" },
  { id: "calendar", audience: "manager" },
  { id: "importedAttendance", audience: "manager" },
  { id: "payroll", audience: "payroll", feature: "payroll" },
  { id: "taxConfig", audience: "payroll", feature: "payroll" },
  { id: "externalPay", audience: "payroll", feature: "kiosk" },
  { id: "documentsAdmin", audience: "admin", feature: "documents" },
  { id: "bylaw", audience: "admin", feature: "penalties" },
  { id: "settingsCenter", audience: "admin" },
  { id: "permissions", audience: "admin" },
  { id: "departments", audience: "admin", feature: "departments" },
  { id: "subscription", audience: "admin" },
  { id: "integrationsApi", audience: "admin" },
  { id: "privacy", audience: "all" },
];

export default function HelpPage() {
  const { t } = useTranslation("help");
  const { profile, hasPermission } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const [showAll, setShowAll] = useState(false);
  const isAdmin = Boolean(profile?.isOwner) || hasPermission("hr.manage");
  const isManager = isAdmin || profile?.roleKey === "manager" || profile?.roleKey === "supervisor" || hasPermission("employees.view");
  const fits = (g: Guide) =>
    g.audience === "all" || (g.audience === "manager" && isManager) || (g.audience === "admin" && isAdmin)
    || (g.audience === "payroll" && (isAdmin || hasPermission("payroll.access")));
  const available = GUIDES.filter((g) => !g.feature || allows(g.feature));
  const mine = available.filter(fits);
  const guideSections = (showAll ? available : mine).map((g) => g.id);
  const hidden = available.length - mine.length;
  const faqEntries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;

  return (
    <PageShell title="">
      <PageBanner pageId="help" illustration={helpHeaderImage} />

      {guideSections.map((section) => (
        <Card key={section} title={t(`guides.${section}.title`)}>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--font-sm)", whiteSpace: "pre-line" }}>{t(`guides.${section}.body`)}</p>
          {section === "privacy" ? (
            <p style={{ margin: "var(--space-3) 0 0", fontSize: "var(--font-sm)" }}>
              <LegalLinks color="var(--text-link)" />
            </p>
          ) : null}
        </Card>
      ))}

      {hidden > 0 ? (
        <div style={{ textAlign: "center", marginBottom: "var(--space-3)" }}>
          <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>{showAll ? t("roleTopicsOnly") : t("showAllTopics", { count: hidden })}</Button>
        </div>
      ) : null}

      <Card title={t("faq.title")}>
        {faqEntries.map((entry) => (
          <div key={entry} style={{ padding: "var(--space-3) 0", borderTop: entry === 1 ? "none" : "1px solid var(--border-light)" }}>
            <p style={{ margin: "0 0 var(--space-1)", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t(`faq.q${entry}.question`)}</p>
            <HintText>{t(`faq.q${entry}.answer`)}</HintText>
          </div>
        ))}
      </Card>

      <Card title={t("contact.title")}>
        <HintText>{t("contact.body")}</HintText>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            {t("contact.infoLabel")}{" "}
            <a href="mailto:info@prosm.net" style={{ color: "var(--text-link)", fontWeight: "var(--font-weight-semibold)" }}>
              info@prosm.net
            </a>
          </span>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            {t("contact.supportLabel")}{" "}
            <a href="mailto:support@prosm.net" style={{ color: "var(--text-link)", fontWeight: "var(--font-weight-semibold)" }}>
              support@prosm.net
            </a>
          </span>
        </div>
      </Card>
    </PageShell>
  );
}
