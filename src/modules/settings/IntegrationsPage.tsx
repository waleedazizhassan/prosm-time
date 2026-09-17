import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import IntegrationsSettingsCard from "./IntegrationsSettingsCard";
import integrationsHeaderImage from "../../assets/illustration-integrations-header.png";

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
      <img
        src={integrationsHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "4.5cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

      <IntegrationsSettingsCard />
    </PageShell>
  );
}
