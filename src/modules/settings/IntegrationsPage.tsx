import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import IntegrationsSettingsCard from "./IntegrationsSettingsCard";

// PROSM Time - § user-directed 2026-09-09: API keys deserve their own
// sidebar entry ("خانة لوحدها") instead of living inside the general
// Settings page - moved out of OrganizationSettingsPage.tsx, same
// Owner-only gate it already had there.
export default function IntegrationsPage() {
  const { t } = useTranslation("settings");
  const { profile } = useAuth();

  if (!profile?.isOwner) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageShell title={t("integrations.title")}>
      <IntegrationsSettingsCard />
    </PageShell>
  );
}
