import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import IntegrationsSettingsCard from "./IntegrationsSettingsCard";
import integrationsHeaderImage from "../../assets/illustrations/integrations.svg";
import PageBanner from "../../components/common/PageBanner";

// PROSM Time - § user-directed 2026-09-09: API keys deserve their own
// sidebar entry ("خانة لوحدها") instead of living inside the general
// Settings page - moved out of OrganizationSettingsPage.tsx, same
// Owner-only gate it already had there.
export default function IntegrationsPage() {
  const { profile } = useAuth();

  if (!profile?.isOwner) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageShell title="">
      <PageBanner pageId="integrations" illustration={integrationsHeaderImage} />

      <IntegrationsSettingsCard />
    </PageShell>
  );
}
