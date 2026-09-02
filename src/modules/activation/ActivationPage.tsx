import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";

import ActivationRepository from "../../core/repositories/ActivationRepository";
import AuthService from "../../core/auth/AuthService";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import LicenseRepository from "../../core/repositories/LicenseRepository";
import { buildLicenseCertificatePdf } from "./licenseCertificatePdf";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time Implementation Master File V3.0, WP-03/§37 - "Activation /
// Welcome." The one screen a brand-new customer reaches with no session
// at all. Real server-side verification happens in
// activate-organization (§5) - this component only collects input and
// reports the real result, never decides activation success itself.
//
// § live UX review, user-directed - "the activation page should let
// you upload the company logo, confirm the password, and after
// pressing Activate automatically download the license (PROSM logo +
// organization logo + PROSM Time)." The logo file itself is only
// SELECTED here (held in memory - there is still no session/
// organization to upload into until after activation succeeds); it
// is uploaded automatically the moment one exists, in the same
// handleSubmit continuation that used to be a separate "add a logo
// now?" screen - that extra screen is gone, since the field is now
// up front. The certificate reuses the same certified-document PDF
// shell (renderHtmlToPdf) every other export in this app already
// uses, built from a fresh read of the real license_activation_state
// row (LicenseRepository) - never data invented client-side.
export default function ActivationPage() {
  const { t, i18n } = useTranslation(["auth", "common"]);
  const navigate = useNavigate();

  const [activationCode, setActivationCode] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [confirmOwnerPassword, setConfirmOwnerPassword] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setLogoFile(event.target.files?.[0] ?? null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (ownerPassword !== confirmOwnerPassword) {
      setError(t("auth:activation.passwordMismatch"));
      return;
    }

    setSubmitting(true);

    const result = await ActivationRepository.activateOrganization({
      activationCode: activationCode.trim(),
      organizationName: organizationName.trim(),
      ownerEmail: ownerEmail.trim(),
      ownerPassword,
      ownerFullName: ownerFullName.trim(),
      siteName: siteName.trim(),
    });

    if (!result.success || !result.data) {
      setSubmitting(false);
      setError(result.message ?? t("auth:activation.genericError"));
      return;
    }

    setSuccess(true);

    // The Owner's password is real and already known here - sign them
    // in immediately rather than sending them back to a second login
    // screen for a credential they just typed once (createUser on the
    // server does not itself establish a client session).
    const signInResult = await AuthService.signIn(ownerEmail.trim(), ownerPassword);

    if (!signInResult.success) {
      setSubmitting(false);
      navigate("/login", { replace: true });
      return;
    }

    let organizationLogoUrl: string | null = null;
    if (logoFile) {
      const uploadResult = await OrganizationRepository.uploadLogo(result.data.organizationId, logoFile);
      if (uploadResult.success) organizationLogoUrl = uploadResult.data;
      // A failed logo upload is never fatal to activation itself - the
      // Owner can always add/change it later from the Header's own
      // organization card.
    }

    const licenseResult = await LicenseRepository.getCurrentLicenseState();
    if (licenseResult.success && licenseResult.data) {
      const license = licenseResult.data;
      const orgResult = await OrganizationRepository.getCurrentOrganization();
      const org = orgResult.success ? orgResult.data : null;
      try {
        const doc = await buildLicenseCertificatePdf(
          {
            organizationName: org?.name ?? organizationName.trim(),
            organizationCode: org?.organizationCode ?? "—",
            siteName: siteName.trim(),
            ownerFullName: ownerFullName.trim(),
            ownerEmail: ownerEmail.trim(),
            licenseNumber: license.licenseNumber,
            status: license.status,
            maxUsers: license.maxUsers,
            maxDevices: license.maxDevices,
            expiresAt: license.expiresAt,
            activatedAt: new Date().toLocaleDateString(i18n.language),
          },
          i18n.language,
          t,
          organizationLogoUrl ?? org?.logoUrl ?? null,
        );
        doc.save(`prosm-time-license-${license.licenseNumber}.pdf`);
      } catch {
        // A failed certificate render/download is display-only and
        // never blocks getting into the app the Owner just activated.
      }
    }

    setSubmitting(false);
    navigate("/dashboard", { replace: true });
  };

  return (
    <AuthLayout
      title={t("auth:activation.title")}
      subtitle={t("auth:activation.subtitle")}
      footer={
        <>
          {t("auth:activation.alreadyHaveAccount")} <Link to="/login">{t("auth:activation.goToLogin")}</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <Input
          label={t("auth:activation.activationCodeLabel")}
          name="activationCode"
          value={activationCode}
          onChange={(event) => setActivationCode(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("auth:activation.organizationNameLabel")}
          name="organizationName"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("auth:activation.siteNameLabel")}
          name="siteName"
          value={siteName}
          onChange={(event) => setSiteName(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("auth:activation.siteNameHelper")}
        />

        <div className={styles.fileFieldContainer}>
          <span className={styles.fileFieldLabel}>{t("auth:activation.logoLabel")}</span>
          <div className={styles.fileFieldRow}>
            <Button type="button" variant="ghost" onClick={() => logoInputRef.current?.click()} disabled={submitting || success}>
              <Upload size={16} /> {logoFile ? t("auth:activation.changeLogoAction") : t("auth:activation.chooseLogoAction")}
            </Button>
            {logoFile ? <span className={styles.fileFieldName}>{logoFile.name}</span> : <span className={styles.fileFieldHint}>{t("auth:activation.logoHint")}</span>}
          </div>
          <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoFileChange} style={{ display: "none" }} />
        </div>

        <Input
          label={t("auth:activation.ownerFullNameLabel")}
          name="ownerFullName"
          value={ownerFullName}
          onChange={(event) => setOwnerFullName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("auth:activation.ownerEmailLabel")}
          name="ownerEmail"
          type="email"
          value={ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
          required
          disabled={submitting || success}
          autoComplete="email"
        />
        <Input
          label={t("auth:activation.ownerPasswordLabel")}
          name="ownerPassword"
          type="password"
          value={ownerPassword}
          onChange={(event) => setOwnerPassword(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("auth:activation.passwordHelper")}
          autoComplete="new-password"
        />
        <Input
          label={t("auth:activation.confirmPasswordLabel")}
          name="confirmOwnerPassword"
          type="password"
          value={confirmOwnerPassword}
          onChange={(event) => setConfirmOwnerPassword(event.target.value)}
          required
          disabled={submitting || success}
          autoComplete="new-password"
        />

        {error ? <p className={styles.errorText}>{error}</p> : null}
        {success ? <p className={styles.successText}>{t("auth:activation.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("auth:activation.submitAction")}
        </Button>
      </form>
    </AuthLayout>
  );
}
