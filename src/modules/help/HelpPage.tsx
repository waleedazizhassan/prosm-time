import { useTranslation } from "react-i18next";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";

// PROSM Time WP-21/§32 - "A dedicated Help area must exist, providing:
// product help, basic usage guidance, FAQ where implemented, support
// contact, information contact." §32 also explicitly forbids inventing
// a support email - only the one real, official info@prosm.com contact
// is shown; a dedicated support address is added later only once
// officially provided.
export default function HelpPage() {
  const { t } = useTranslation("help");

  const guideSections = ["gettingStarted", "attendance", "timesheets", "kiosk", "exceptions"] as const;
  const faqEntries = [1, 2, 3, 4] as const;

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
        <a href="mailto:info@prosm.com" style={{ color: "var(--text-link)", fontWeight: "var(--font-weight-semibold)", fontSize: "var(--font-sm)" }}>
          info@prosm.com
        </a>
      </Card>
    </PageShell>
  );
}
