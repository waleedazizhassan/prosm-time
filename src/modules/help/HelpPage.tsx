import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import helpHeaderImage from "../../assets/illustration-help-header.png";

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
    "walkInGeofence",
    "siteChange",
    "sos",
    "notifications",
    "timesheets",
    "exceptions",
    "allowances",
    "leave",
    "schedule",
    "kiosk",
    "reportsCenter",
    "sites",
    "settingsCenter",
    // "payrollIntegration" removed 2026-09-15 along with QuickBooks
    // itself (user-directed - PROSM Finance now computes payroll
    // natively, no external payroll software needed). The Payroll
    // Integration card (OrganizationSettingsPage.tsx) is still hidden
    // regardless - Xero/Gusto remain dormant - so this list entry and
    // its help.json content were both deleted rather than left stale.
    // A new guide (Xero/Gusto-specific, not a QuickBooks rewrite) would
    // be needed if that card is ever brought back for real.
    "permissions",
    "calendar",
    "desktopApp",
    "liveMap",
    "radio",
  ] as const;
  const faqEntries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

  return (
    <PageShell title="">
      <img
        src={helpHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "4.5cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

      {guideSections.map((section) => (
        <Card key={section} title={t(`guides.${section}.title`)}>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--font-sm)", whiteSpace: "pre-line" }}>{t(`guides.${section}.body`)}</p>
        </Card>
      ))}

      <Card title={t("faq.title")}>
        {faqEntries.map((entry) => (
          <div key={entry} style={{ padding: "var(--space-3) 0", borderTop: entry === 1 ? "none" : "1px solid var(--border-light)" }}>
            <p style={{ margin: "0 0 var(--space-1)", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t(`faq.q${entry}.question`)}</p>
            <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t(`faq.q${entry}.answer`)}</p>
          </div>
        ))}
      </Card>

      <Card title={t("contact.title")}>
        <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("contact.body")}</p>
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
