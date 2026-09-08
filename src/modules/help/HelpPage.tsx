import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";

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
    "kiosk",
    "reportsCenter",
    "sites",
    "settingsCenter",
    "payrollIntegration",
    "permissions",
    "desktopApp",
    "liveMap",
    "radio",
  ] as const;
  const faqEntries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
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
