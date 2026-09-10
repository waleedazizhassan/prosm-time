import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Check, Delete } from "lucide-react";

import KioskRepository, { type KioskRosterEntry } from "../../core/repositories/KioskRepository";
import SiteWorkerRepository from "../../core/repositories/SiteWorkerRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import CameraCaptureModal from "../../components/common/CameraCaptureModal";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ErrorText from "../../components/common/ErrorText";
import styles from "./KioskPage.module.css";

type Mode = "employees" | "workforce";
type Screen = "roster" | "pin" | "keypad" | "success";

const AUTO_RETURN_MS = 4000;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

// PROSM Time WP-18/§13.1 - "Kiosk Mode." Locked-down shared-device
// screen. Two independent identity paths, one shared screen: (1)
// "Employees" - pick yourself from the roster, enter your own PIN
// (unchanged from the original WP-18 design - identity is proven by
// the PIN alone, never the operating browser session); (2)
// "Workforce" - § user-directed: external/contractor labor, identity
// proven by a single 6-digit number (no PIN, no photo, but a real GPS
// sample is mandatory - see 20260910100000's own header comment for
// the full design reasoning).
export default function KioskPage() {
  const { t } = useTranslation("kiosk");
  const { siteId } = useParams<{ siteId: string }>();

  const [site, setSite] = useState<Site | null>(null);
  const [roster, setRoster] = useState<KioskRosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [mode, setMode] = useState<Mode>("employees");
  const [screen, setScreen] = useState<Screen>("roster");
  const [selectedEmployee, setSelectedEmployee] = useState<KioskRosterEntry | null>(null);
  const [pin, setPin] = useState("");
  const [workerNumber, setWorkerNumber] = useState("");
  const [pendingAction, setPendingAction] = useState<"in" | "out" | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitting, setSubmitting] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [now, setNow] = useState(new Date());

  const autoReturnRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setLoadError("");
    const [siteResult, rosterResult] = await Promise.all([SiteRepository.getSite(siteId), KioskRepository.getRoster(siteId)]);
    if (!siteResult.success || !siteResult.data) {
      setLoadError(humanizeBackendError(siteResult.message, t) ?? t("loadError"));
    } else {
      setSite(siteResult.data);
      if (!rosterResult.success) {
        setLoadError(humanizeBackendError(rosterResult.message, t) ?? t("loadError"));
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
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
    };
  }, []);

  const resetToRoster = useCallback(
    (nextMode?: Mode) => {
      if (autoReturnRef.current) clearTimeout(autoReturnRef.current);
      const targetMode = nextMode ?? mode;
      if (nextMode) setMode(nextMode);
      // § real bug, live-reported - this used to always land on
      // "roster", but that screen only ever renders in employees mode
      // (see the JSX below). Landing there while in workforce mode
      // matched no render branch at all, so only the header painted -
      // the reported "blank navy screen" after a workforce clock-in.
      // Each mode has its own real landing screen; return to it.
      setScreen(targetMode === "workforce" ? "keypad" : "roster");
      setSelectedEmployee(null);
      setPin("");
      setWorkerNumber("");
      setPendingAction(null);
      setCameraOpen(false);
      setError("");
      setSuccessMessage("");
    },
    [mode],
  );

  const handleSwitchMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    resetToRoster(nextMode);
    setScreen(nextMode === "workforce" ? "keypad" : "roster");
  };

  const handleSelectEmployee = (employee: KioskRosterEntry) => {
    setSelectedEmployee(employee);
    setPin("");
    setError("");
    setScreen("pin");
  };

  const performAction = async (action: "in" | "out", evidenceFile: File | null) => {
    if (!siteId || !selectedEmployee) return;
    setSubmitting(action);
    setError("");

    const result = action === "in" ? await KioskRepository.kioskClockIn(siteId, selectedEmployee.userId, pin) : await KioskRepository.kioskClockOut(siteId, selectedEmployee.userId, pin);

    if (!result.success || !result.data) {
      setSubmitting(null);
      setError(humanizeBackendError(result.message, t) ?? t("actionError"));
      return;
    }

    if (evidenceFile) {
      await EvidenceRepository.uploadEvidence(result.data.eventId, evidenceFile);
    }

    setSubmitting(null);
    setSuccessMessage(action === "in" ? t("clockInSuccess", { name: selectedEmployee.fullName }) : t("clockOutSuccess", { name: selectedEmployee.fullName }));
    setScreen("success");
    autoReturnRef.current = setTimeout(() => resetToRoster(), AUTO_RETURN_MS);
  };

  const handleActionTap = (action: "in" | "out") => {
    if (!site || !selectedEmployee || pin.length < 4) return;
    if (site.cameraRequired) {
      setPendingAction(action);
      setCameraOpen(true);
      return;
    }
    performAction(action, null);
  };

  const handleCameraCapture = (file: File) => {
    setCameraOpen(false);
    const action = pendingAction;
    setPendingAction(null);
    if (action) performAction(action, file);
  };

  const handleCameraClose = () => {
    setCameraOpen(false);
    setPendingAction(null);
  };

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
    autoReturnRef.current = setTimeout(() => resetToRoster("workforce"), AUTO_RETURN_MS);
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
        <div className={styles.modeSwitch}>
          <button type="button" className={`${styles.modeButton} ${mode === "employees" ? styles.modeButtonActive : ""}`} onClick={() => handleSwitchMode("employees")}>
            {t("modeEmployees")}
          </button>
          <button type="button" className={`${styles.modeButton} ${mode === "workforce" ? styles.modeButtonActive : ""}`} onClick={() => handleSwitchMode("workforce")}>
            {t("modeWorkforce")}
          </button>
        </div>
      </div>

      {mode === "employees" && screen === "roster" ? (
        <div className={styles.screen}>
          <div className={styles.card}>
            <p className={styles.selectedName} style={{ marginBottom: "var(--space-4)" }}>
              {t("selectYourself")}
            </p>
            {roster.length === 0 ? (
              <EmptyState message={t("noRoster")} />
            ) : (
              <div className={styles.rosterGrid}>
                {roster.map((employee) => (
                  <button key={employee.userId} type="button" className={styles.rosterButton} onClick={() => handleSelectEmployee(employee)}>
                    <span className={styles.avatar}>{initials(employee.fullName)}</span>
                    {employee.fullName}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {mode === "employees" && screen === "pin" && selectedEmployee ? (
        <div className={styles.screen}>
          <div className={styles.card}>
            <div className={styles.selectedHeader}>
              <span className={`${styles.avatar} ${styles.selectedAvatar}`}>{initials(selectedEmployee.fullName)}</span>
              <h2 className={styles.selectedName}>{selectedEmployee.fullName}</h2>
            </div>
            <div className={styles.pinCard}>
              <ErrorText>{error}</ErrorText>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))}
                placeholder={t("pinPlaceholder")}
                className={styles.pinInput}
                disabled={Boolean(submitting)}
                autoFocus
              />
              {site.cameraRequired ? <p className={styles.evidenceHint}>{t("evidenceRequiredHint")}</p> : null}
              <div className={styles.actionRow}>
                <Button variant="ghost" size="md" fullWidth onClick={() => resetToRoster()} disabled={Boolean(submitting)}>
                  {t("cancelAction")}
                </Button>
                <Button size="md" fullWidth onClick={() => handleActionTap("in")} loading={submitting === "in"} disabled={pin.length < 4 || Boolean(submitting)}>
                  {t("clockInAction")}
                </Button>
                <Button size="md" fullWidth onClick={() => handleActionTap("out")} loading={submitting === "out"} disabled={pin.length < 4 || Boolean(submitting)}>
                  {t("clockOutAction")}
                </Button>
              </div>
            </div>
          </div>

          <CameraCaptureModal isOpen={cameraOpen} onClose={handleCameraClose} onCapture={handleCameraCapture} />
        </div>
      ) : null}

      {mode === "workforce" && screen === "keypad" ? (
        <div className={styles.screen}>
          <div className={styles.card}>
            <div className={styles.pinCard} style={{ maxWidth: 340, margin: "0 auto" }}>
              <p className={styles.selectedName}>{t("workerNumberPrompt")}</p>
              <div className={styles.workerNumberDisplay}>
                {workerNumber.padEnd(6, "•")
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
                <button
                  type="button"
                  className={`${styles.keypadButton} ${styles.keypadButtonMuted}`}
                  onClick={() => setWorkerNumber("")}
                  disabled={Boolean(submitting)}
                >
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
      ) : null}

      {screen === "success" ? (
        <div className={styles.screen}>
          <div className={styles.card}>
            <div className={styles.successCard}>
              <span className={styles.successIcon}>
                <Check size={36} />
              </span>
              <p className={styles.successMessage}>{successMessage}</p>
              <Button onClick={() => resetToRoster(mode)}>{t("backToRosterAction")}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
