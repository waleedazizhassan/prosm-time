import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import IntegrationsSettingsCard from "./IntegrationsSettingsCard";
import integrationsHeaderImage from "../../assets/illustration-integrations-header.webp";
import PageBannerImage from "../../components/common/PageBannerImage";

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
      <PageBannerImage src={integrationsHeaderImage} />

      <IntegrationsSettingsCard />
    </PageShell>
  );
}
