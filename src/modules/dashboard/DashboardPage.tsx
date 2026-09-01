import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import OrganizationRepository, { type Organization } from "../../core/repositories/OrganizationRepository";
import LicenseRepository, { type LicenseState } from "../../core/repositories/LicenseRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import ClockInOutCard from "./ClockInOutCard";
import ExceptionsCard from "./ExceptionsCard";
import KioskPinCard from "./KioskPinCard";
import { formatDateOnly } from "../../core/utils/formatDate";

// PROSM Time Implementation Master File V3.0, WP-03/§21/§37 - "Admin
// Dashboard." Deliberately minimal: real organization identity and a
// real, refreshable read-only reflection of PROSM Management's license
// state (§37: "License & Plan (read-only reflection of PROSM
// Management state)") - not the full Manager/Administration Console
// (§21), which is WP-14's own scope once sites/employees/attendance
// exist to actually show. Sign-out and cross-page navigation now live
// in the application shell (Sidebar/User Menu, § visual consistency
// pass) - this page only owns its own content.
export default function DashboardPage() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [orgResult, licenseResult] = await Promise.all([
      OrganizationRepository.getCurrentOrganization(),
      LicenseRepository.getCurrentLicenseState(),
    ]);
    if (orgResult.success) setOrganization(orgResult.data);
    if (licenseResult.success) setLicense(licenseResult.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefreshLicense = async () => {
    setRefreshing(true);
    setRefreshError("");
    const result = await LicenseRepository.refreshCurrentLicenseStatus();
    setRefreshing(false);
    if (!result.success) {
      setRefreshError(result.message ?? t("licenseCard.refreshError"));
      return;
    }
    await load();
  };

  return (
    <PageShell title={t("title")} subtitle={profile ? t("welcomeMessage", { name: profile.fullName }) : undefined}>
      <ClockInOutCard />
      <ExceptionsCard />
      <KioskPinCard />

      {loading ? (
        <p>…</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
          <Card title={t("organizationCard.title")}>
            {organization ? (
              <dl style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                <dt style={{ color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>{organization.name}</dt>
                <dd style={{ margin: "var(--space-2) 0" }}>
                  {t("organizationCard.codeLabel")}: {organization.organizationCode}
                </dd>
                <dd style={{ margin: 0 }}>
                  {t("organizationCard.statusLabel")}: <StatusBadge status={organization.status}>{organization.status}</StatusBadge>
                </dd>
              </dl>
            ) : null}
          </Card>

          <Card title={t("licenseCard.title")}>
            {license ? (
              <dl style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                <dd style={{ margin: "0 0 var(--space-2)" }}>
                  {t("licenseCard.licenseNumberLabel")}: {license.licenseNumber}
                </dd>
                <dd style={{ margin: "0 0 var(--space-2)" }}>
                  {t("licenseCard.statusLabel")}: <StatusBadge status={license.status}>{t(`licenseCard.status.${license.status}`, { defaultValue: license.status })}</StatusBadge>
                </dd>
                <dd style={{ margin: "0 0 var(--space-2)" }}>
                  {t("licenseCard.usersLabel")}: {license.maxUsers ?? "—"} · {t("licenseCard.devicesLabel")}: {license.maxDevices ?? "—"}
                </dd>
                <dd style={{ margin: "0 0 var(--space-3)" }}>
                  {t("licenseCard.expiresLabel")}: {license.expiresAt ? formatDateOnly(license.expiresAt, i18n.language) : t("licenseCard.noExpiry")}
                </dd>
              </dl>
            ) : null}
            {refreshError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{refreshError}</p> : null}
            <Button variant="ghost" size="sm" loading={refreshing} onClick={handleRefreshLicense}>
              {t("licenseCard.refreshAction")}
            </Button>
          </Card>
        </div>
      )}

      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("comingSoon")}</p>
    </PageShell>
  );
}
