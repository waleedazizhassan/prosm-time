import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";

import ActivationRepository from "../../core/repositories/ActivationRepository";
import AuthService from "../../core/auth/AuthService";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import BrandMark from "../../components/common/BrandMark";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time Implementation Master File V3.0, WP-03/§37 - "Activation /
// Welcome." The one screen a brand-new customer reaches with no session
// at all. Real server-side verification happens in
// activate-organization (§5) - this component only collects input and
// reports the real result, never decides activation success itself.
//
// § live UX review, user-directed - "a place to upload the company
// logo during activation." The activation form itself runs with NO
// session at all (the organization doesn't exist yet), so there is no
// valid path/owner-check to upload into until AFTER activation
// succeeds and the Owner is signed in - that happens a few lines
// below in handleSubmit. Rather than force a real upload into a
// pre-session form, this is a distinct step shown right after sign-in
// succeeds (organizationId + a real authenticated session both exist
// by then), before the existing navigate-to-dashboard redirect -
// optional, skippable, and reachable again anytime afterward from the
// Header's own organization card for an org that skips it here.
export default function ActivationPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();

  const [activationCode, setActivationCode] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const [signedIn, setSignedIn] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    const result = await ActivationRepository.activateOrganization({
      activationCode: activationCode.trim(),
      organizationName: organizationName.trim(),
      ownerEmail: ownerEmail.trim(),
      ownerPassword,
      ownerFullName: ownerFullName.trim(),
      siteName: siteName.trim(),
    });

    if (!result.success) {
      setSubmitting(false);
      setError(result.message ?? t("activation.genericError"));
      return;
    }

    setSuccess(true);

    // The Owner's password is real and already known here - sign them
    // in immediately rather than sending them back to a second login
    // screen for a credential they just typed once (createUser on the
    // server does not itself establish a client session).
    const signInResult = await AuthService.signIn(ownerEmail.trim(), ownerPassword);
    setSubmitting(false);

    if (signInResult.success && result.data) {
      setOrganizationId(result.data.organizationId);
      setSignedIn(true);
    } else if (signInResult.success) {
      navigate("/dashboard", { replace: true });
    } else {
      navigate("/login", { replace: true });
    }
  };

  const handleLogoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !organizationId) return;

    setUploadingLogo(true);
    setLogoError("");
    const result = await OrganizationRepository.uploadLogo(organizationId, file);
    setUploadingLogo(false);

    if (!result.success) {
      setLogoError(result.message ?? t("activation.logoUploadError"));
      return;
    }
    navigate("/dashboard", { replace: true });
  };

  if (signedIn) {
    return (
      <AuthLayout title={t("activation.logoStepTitle")} subtitle={t("activation.logoStepSubtitle")}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-4)", padding: "var(--space-4) 0" }}>
          <BrandMark size={64} />
          {logoError ? <p className={styles.errorText}>{logoError}</p> : null}
          <Button type="button" fullWidth onClick={() => logoInputRef.current?.click()} loading={uploadingLogo}>
            <Upload size={16} /> {t("activation.uploadLogoAction")}
          </Button>
          <button type="button" className={styles.textLink} onClick={() => navigate("/dashboard", { replace: true })} disabled={uploadingLogo}>
            {t("activation.skipLogoAction")}
          </button>
          <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoFileChange} style={{ display: "none" }} />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("activation.title")}
      subtitle={t("activation.subtitle")}
      footer={
        <>
          {t("activation.alreadyHaveAccount")} <Link to="/login">{t("activation.goToLogin")}</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <Input
          label={t("activation.activationCodeLabel")}
          name="activationCode"
          value={activationCode}
          onChange={(event) => setActivationCode(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.organizationNameLabel")}
          name="organizationName"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.siteNameLabel")}
          name="siteName"
          value={siteName}
          onChange={(event) => setSiteName(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("activation.siteNameHelper")}
        />
        <Input
          label={t("activation.ownerFullNameLabel")}
          name="ownerFullName"
          value={ownerFullName}
          onChange={(event) => setOwnerFullName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.ownerEmailLabel")}
          name="ownerEmail"
          type="email"
          value={ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
          required
          disabled={submitting || success}
          autoComplete="email"
        />
        <Input
          label={t("activation.ownerPasswordLabel")}
          name="ownerPassword"
          type="password"
          value={ownerPassword}
          onChange={(event) => setOwnerPassword(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("activation.passwordHelper")}
          autoComplete="new-password"
        />

        {error ? <p className={styles.errorText}>{error}</p> : null}
        {success ? <p className={styles.successText}>{t("activation.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("activation.submitAction")}
        </Button>
      </form>
    </AuthLayout>
  );
}
