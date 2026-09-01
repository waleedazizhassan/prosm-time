import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";

import KioskRepository, { type KioskRosterEntry } from "../../core/repositories/KioskRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import EvidenceCaptureField from "../../components/common/EvidenceCaptureField";
import styles from "./KioskPage.module.css";

type Screen = "roster" | "pin" | "success";

const AUTO_RETURN_MS = 4000;

// PROSM Time WP-18/§13.1 - "Kiosk Mode." Locked-down shared-device
// screen: pick yourself from the roster, enter your own PIN, capture
// evidence if the site requires it, Clock In/Out. Identity is proven
// by the PIN alone (see the WP-18 migration's own header comment) -
// this screen never assumes the operating browser session belongs to
// the employee being clocked in.
export default function KioskPage() {
  const { t } = useTranslation("kiosk");
  const { siteId } = useParams<{ siteId: string }>();

  const [site, setSite] = useState<Site | null>(null);
  const [roster, setRoster] = useState<KioskRosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [screen, setScreen] = useState<Screen>("roster");
  const [selectedEmployee, setSelectedEmployee] = useState<KioskRosterEntry | null>(null);
  const [pin, setPin] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const autoReturnRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setLoadError("");
    const [siteResult, rosterResult] = await Promise.all([SiteRepository.getSite(siteId), KioskRepository.getRoster(siteId)]);
    if (!siteResult.success || !siteResult.data) {
      setLoadError(siteResult.message ?? t("loadError"));
    } else {
      setSite(siteResult.data);
      if (!rosterResult.success) {
        setLoadError(rosterResult.message ?? t("loadError"));
      } else {
        setRoster(rosterResult.data ?? []);
      }
    }
    setLoading(false);
  }, [siteId, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
    };
  }, []);

  const resetToRoster = useCallback(() => {
    if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
    setScreen("roster");
    setSelectedEmployee(null);
    setPin("");
    setEvidenceFile(null);
    setError("");
    setSuccessMessage("");
  }, []);

  const handleSelectEmployee = (employee: KioskRosterEntry) => {
    setSelectedEmployee(employee);
    setPin("");
    setEvidenceFile(null);
    setError("");
    setScreen("pin");
  };

  const handleAction = async (action: "in" | "out") => {
    if (!siteId || !selectedEmployee || pin.length < 4) return;
    setSubmitting(action);
    setError("");

    const result = action === "in" ? await KioskRepository.kioskClockIn(siteId, selectedEmployee.userId, pin) : await KioskRepository.kioskClockOut(siteId, selectedEmployee.userId, pin);

    if (!result.success || !result.data) {
      setSubmitting(null);
      setError(result.message ?? t("actionError"));
      return;
    }

    if (evidenceFile) {
      await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
    }

    setSubmitting(null);
    setSuccessMessage(action === "in" ? t("clockInSuccess", { name: selectedEmployee.fullName }) : t("clockOutSuccess", { name: selectedEmployee.fullName }));
    setScreen("success");
    autoReturnRef.current = setTimeout(resetToRoster, AUTO_RETURN_MS);
  };

  if (loading) {
    return (
      <PageShell title={t("title")}>
        <p>…</p>
      </PageShell>
    );
  }

  if (loadError || !site) {
    return (
      <PageShell title={t("title")}>
        <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{loadError || t("loadError")}</p>
      </PageShell>
    );
  }

  return (
    <PageShell title={site.name} subtitle={t("subtitle")}>
      {screen === "roster" ? (
        <div className={styles.screen}>
          <h2 className={styles.siteName}>{t("selectYourself")}</h2>
          {roster.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>{t("noRoster")}</p>
          ) : (
            <div className={styles.rosterGrid}>
              {roster.map((employee) => (
                <button key={employee.userId} type="button" className={styles.rosterButton} onClick={() => handleSelectEmployee(employee)}>
                  {employee.fullName}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {screen === "pin" && selectedEmployee ? (
        <div className={styles.screen}>
          <h2 className={styles.siteName}>{selectedEmployee.fullName}</h2>
          <div className={styles.pinCard}>
            {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))}
              placeholder={t("pinPlaceholder")}
              className={styles.pinInput}
              disabled={Boolean(submitting)}
            />
            {site.cameraRequired ? <EvidenceCaptureField label={t("evidenceLabel")} file={evidenceFile} onChange={setEvidenceFile} disabled={Boolean(submitting)} helperText={t("evidenceRequiredHint")} /> : null}
            <div className={styles.actionRow}>
              <Button variant="ghost" size="md" fullWidth onClick={resetToRoster} disabled={Boolean(submitting)}>
                {t("cancelAction")}
              </Button>
              <Button size="md" fullWidth onClick={() => handleAction("in")} loading={submitting === "in"} disabled={pin.length < 4 || Boolean(submitting) || (site.cameraRequired && !evidenceFile)}>
                {t("clockInAction")}
              </Button>
              <Button size="md" fullWidth onClick={() => handleAction("out")} loading={submitting === "out"} disabled={pin.length < 4 || Boolean(submitting) || (site.cameraRequired && !evidenceFile)}>
                {t("clockOutAction")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {screen === "success" ? (
        <div className={styles.screen}>
          <p className={styles.successMessage}>{successMessage}</p>
          <Button onClick={resetToRoster}>{t("backToRosterAction")}</Button>
        </div>
      ) : null}
    </PageShell>
  );
}
