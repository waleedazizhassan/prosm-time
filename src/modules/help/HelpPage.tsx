import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import helpHeaderImage from "../../assets/illustrations/help.svg";
import PageBanner from "../../components/common/PageBanner";
import LegalLinks from "../legal/LegalLinks";
import HintText from "../../components/common/HintText";
import { APP_VERSION } from "../../core/appVersion";

// PROSM Time WP-21/§32 - "A dedicated Help area must exist, providing:
// product help, basic usage guidance, FAQ where implemented, support
// contact, information contact." Both real, official addresses are
// shown - info@prosm.net for general/information contact, and
// support@prosm.net (added per explicit user-directed request) as the
// dedicated support contact.
export default function HelpPage() {
  const { t } = useTranslation("help");

  const guideSections = [
    "gettingStarted",
    "attendance",
    "offline",
    "walkInGeofence",
    "siteChange",
    "locationChecks",
    "sos",
    "notifications",
    "timesheets",
    "exceptions",
    "longSessions",
    "overtimeControl",
    "leavingSite",
    "liveCheck",
    "allowances",
    "leave",
    "workCalendar",
    "schedule",
    "kiosk",
    "reportsCenter",
    "sites",
    "workers",
    "settingsCenter",
    "managerDashboard",
    "peopleAndPhotos",
    "permissions",
    "calendar",
    "phoneNotifications",
    "getTheApp",
    "liveMap",
    "radio",
    "privacy",
  ] as const;
  const faqEntries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

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
      {/* v2.3.43 step 16 (item 26): the version lives here (and in Settings), for support - not in the sidebar. */}
      <Card title={t("about.title")}>
        <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("common:versionLabel", { version: APP_VERSION })}</p>
      </Card>
    </PageShell>
  );
}
