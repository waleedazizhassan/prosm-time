import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Check, Delete } from "lucide-react";

import SiteWorkerRepository from "../../core/repositories/SiteWorkerRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import LoadingState from "../../components/common/LoadingState";
import ErrorText from "../../components/common/ErrorText";
import styles from "./KioskPage.module.css";

type Screen = "keypad" | "success";

const AUTO_RETURN_MS = 4000;

// PROSM Time - Kiosk Mode: a shared device at a site's entrance where
// external workers (no account, no phone) clock in and out with the
// 6-digit number the app gave them; a real GPS sample is mandatory
// (20260910100000). Owner 2026-10-21: the kiosk is for external workers
// only - the employees' roster-and-PIN kiosk is removed (employees clock
// in from their own app).
export default function KioskPage() {
  const { t } = useTranslation("kiosk");
  const { siteId } = useParams<{ siteId: string }>();

  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [screen, setScreen] = useState<Screen>("keypad");
  const [workerNumber, setWorkerNumber] = useState("");
  const [submitting, setSubmitting] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [now, setNow] = useState(new Date());

  const autoReturnRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setLoadError("");
    const siteResult = await SiteRepository.getSite(siteId);
    if (!siteResult.success || !siteResult.data) {
      setLoadError(humanizeBackendError(siteResult.message, t) ?? t("loadError"));
    } else {
      setSite(siteResult.data);
    }
    setLoading(false);
  }, [siteId, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
    };
  }, []);

  const resetToKeypad = useCallback(() => {
    if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
    setScreen("keypad");
    setWorkerNumber("");
    setError("");
    setSuccessMessage("");
  }, []);

  const captureGps = (): Promise<{ latitude: number; longitude: number }> =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("no-geolocation"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        () => reject(new Error("geolocation-failed")),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });

  const handleWorkerAction = async (action: "in" | "out") => {
    if (!siteId || workerNumber.length !== 6) return;
    setSubmitting(action);
    setError("");

    let coords: { latitude: number; longitude: number };
    try {
      coords = await captureGps();
    } catch {
      setSubmitting(null);
      setError(t("locationError"));
      return;
    }

    const result =
      action === "in"
        ? await SiteWorkerRepository.kioskClockIn(siteId, workerNumber, coords.latitude, coords.longitude)
        : await SiteWorkerRepository.kioskClockOut(siteId, workerNumber, coords.latitude, coords.longitude);

    setSubmitting(null);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("actionError"));
      return;
    }

    setSuccessMessage(action === "in" ? t("workerClockInSuccess", { name: result.data.workerName }) : t("workerClockOutSuccess", { name: result.data.workerName }));
    setScreen("success");
    autoReturnRef.current = setTimeout(resetToKeypad, AUTO_RETURN_MS);
  };

  const handleKeypadDigit = (digit: string) => {
    if (workerNumber.length >= 6) return;
    setWorkerNumber((prev) => prev + digit);
  };

  if (loading) {
    return (
      <PageShell title={t("title")}>
        <LoadingState fullHeight />
      </PageShell>
    );
  }

  if (loadError || !site) {
    return (
      <PageShell title={t("title")}>
        <ErrorText>{loadError || t("loadError")}</ErrorText>
      </PageShell>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <p className={styles.siteName}>{site.name}</p>
        <p className={styles.clock}>{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>
        <p className={styles.dateLine}>{now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>

      {screen === "keypad" ? (
        <div className={styles.screen}>
          <div className={styles.card}>
            <div className={styles.pinCard} style={{ maxWidth: 340, margin: "0 auto" }}>
              <p className={styles.selectedName}>{t("workerNumberPrompt")}</p>
              <div className={styles.workerNumberDisplay}>
                {workerNumber
                  .padEnd(6, "•")
                  .split("")
                  .map((char, index) => (
                    <span key={index} className={index >= workerNumber.length ? styles.workerNumberPlaceholder : undefined}>
                      {char}
                    </span>
                  ))}
              </div>
              <ErrorText>{error}</ErrorText>
              {submitting ? <p className={styles.evidenceHint}>{t("locatingHint")}</p> : null}

              <div className={styles.keypad}>
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <button key={digit} type="button" className={styles.keypadButton} onClick={() => handleKeypadDigit(digit)} disabled={Boolean(submitting)}>
                    {digit}
                  </button>
                ))}
                <button type="button" className={`${styles.keypadButton} ${styles.keypadButtonMuted}`} onClick={() => setWorkerNumber("")} disabled={Boolean(submitting)}>
                  {t("keypadClear")}
                </button>
                <button type="button" className={styles.keypadButton} onClick={() => handleKeypadDigit("0")} disabled={Boolean(submitting)}>
                  0
                </button>
                <button
                  type="button"
                  className={styles.keypadButton}
                  onClick={() => setWorkerNumber((prev) => prev.slice(0, -1))}
                  disabled={Boolean(submitting)}
                  aria-label={t("keypadBackspace")}
                >
                  <Delete size={20} style={{ margin: "0 auto" }} />
                </button>
              </div>

              <div className={styles.actionRow}>
                <Button size="md" fullWidth onClick={() => handleWorkerAction("in")} loading={submitting === "in"} disabled={workerNumber.length !== 6 || Boolean(submitting)}>
                  {t("clockInAction")}
                </Button>
                <Button size="md" fullWidth onClick={() => handleWorkerAction("out")} loading={submitting === "out"} disabled={workerNumber.length !== 6 || Boolean(submitting)}>
                  {t("clockOutAction")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.screen}>
          <div className={styles.card}>
            <div className={styles.successCard}>
              <span className={styles.successIcon}>
                <Check size={36} />
              </span>
              <p className={styles.successMessage}>{successMessage}</p>
              <Button onClick={resetToKeypad}>{t("backToRosterAction")}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
