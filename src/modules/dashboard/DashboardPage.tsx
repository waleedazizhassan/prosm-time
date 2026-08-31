import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import OrganizationRepository, { type Organization } from "../../core/repositories/OrganizationRepository";
import LicenseRepository, { type LicenseState } from "../../core/repositories/LicenseRepository";

import Button from "../../components/common/Button";
import BrandMark from "../../components/common/BrandMark";

// PROSM Time Implementation Master File V3.0, WP-03/§21/§37 - "Admin
// Dashboard." Deliberately minimal: real organization identity and a
// real, refreshable read-only reflection of PROSM Management's license
// state (§37: "License & Plan (read-only reflection of PROSM
// Management state)") - not the full Manager/Administration Console
// (§21), which is WP-14's own scope once sites/employees/attendance
// exist to actually show.
export default function DashboardPage() {
  const { t } = useTranslation("dashboard");
  const { profile, signOut } = useAuth();

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
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <BrandMark size={32} />
          <div>
            <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{t("title")}</h1>
            {profile ? <p style={{ color: "var(--text-secondary)", margin: 0 }}>{t("welcomeMessage", { name: profile.fullName })}</p> : null}
          </div>
        </div>
        <Button variant="ghost" onClick={signOut}>
          {t("signOutAction")}
        </Button>
      </div>

      {loading ? (
        <p>…</p>
      ) : (
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "1fr 1fr" }}>
          <section style={{ background: "var(--surface-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "1.25rem" }}>
            <h2 style={{ fontSize: "1rem", marginTop: 0 }}>{t("organizationCard.title")}</h2>
            {organization ? (
              <dl style={{ margin: 0 }}>
                <dt style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{organization.name}</dt>
                <dd style={{ margin: "0.25rem 0 0.75rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                  {t("organizationCard.codeLabel")}: {organization.organizationCode}
                </dd>
                <dd style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                  {t("organizationCard.statusLabel")}: {organization.status}
                </dd>
              </dl>
            ) : null}
          </section>

          <section style={{ background: "var(--surface-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "1.25rem" }}>
            <h2 style={{ fontSize: "1rem", marginTop: 0 }}>{t("licenseCard.title")}</h2>
            {license ? (
              <dl style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                <dd style={{ margin: "0 0 0.5rem" }}>
                  {t("licenseCard.licenseNumberLabel")}: {license.licenseNumber}
                </dd>
                <dd style={{ margin: "0 0 0.5rem" }}>
                  {t("licenseCard.statusLabel")}: {t(`licenseCard.status.${license.status}`, { defaultValue: license.status })}
                </dd>
                <dd style={{ margin: "0 0 0.5rem" }}>
                  {t("licenseCard.usersLabel")}: {license.maxUsers ?? "—"} · {t("licenseCard.devicesLabel")}: {license.maxDevices ?? "—"}
                </dd>
                <dd style={{ margin: "0 0 0.75rem" }}>
                  {t("licenseCard.expiresLabel")}: {license.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : t("licenseCard.noExpiry")}
                </dd>
              </dl>
            ) : null}
            {refreshError ? <p style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{refreshError}</p> : null}
            <Button variant="ghost" loading={refreshing} onClick={handleRefreshLicense}>
              {t("licenseCard.refreshAction")}
            </Button>
          </section>
        </div>
      )}

      <p style={{ marginTop: "2rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>{t("comingSoon")}</p>
    </div>
  );
}
