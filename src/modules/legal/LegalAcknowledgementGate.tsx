import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Check, Eye, MapPin, Radar, type LucideIcon } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import LegalRepository from "../../core/repositories/LegalRepository";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import LegalLinks from "./LegalLinks";
import { LEGAL_VERSION } from "./legalContent";
import { startupCheck } from "../../core/utils/startupCheck";
import styles from "./LegalAcknowledgementGate.module.css";

const cacheKey = (userId: string) => `prosm_time_legal_ack_${LEGAL_VERSION}_${userId}`;

function readCache(userId: string): boolean {
  try {
    return localStorage.getItem(cacheKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeCache(userId: string) {
  try {
    localStorage.setItem(cacheKey(userId), "1");
  } catch {
    // storage unavailable - the server record is what counts
  }
}

// Owner 2026-10-13: before using the app, each person reads what PROSM Time
// records about them and acknowledges the Privacy Policy and Terms of Use
// (the Owner also accepts the Terms for the organisation). Recorded on the
// server once per version. Without a connection the app opens as usual -
// offline attendance must never be blocked - and asks again when online.
export default function LegalAcknowledgementGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const { profile, signOut } = useAuth();
  const userId = profile?.id ?? null;
  const [status, setStatus] = useState<"checking" | "needed" | "done">(() => (userId && readCache(userId) ? "done" : "checking"));
  const [checked, setChecked] = useState(false);
  const [euChecked, setEuChecked] = useState(false);
  // Plan stage 7.3: location and photo apart from the policy, dated, before the first clock-in.
  const [captureChecked, setCaptureChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!userId) return undefined;
    if (readCache(userId)) {
      setStatus("done");
      return undefined;
    }
    let active = true;
    startupCheck(() => LegalRepository.hasAcknowledged(userId, LEGAL_VERSION)).then((result) => {
      if (!active) return;
      if (!result) {
        // No connection, or no answer in time: do not block the app.
        setStatus("done");
      } else if (result.success && result.data) {
        writeCache(userId);
        setStatus("done");
      } else if (result.success) {
        setStatus("needed");
      } else {
        // Could not check (offline or server unreachable): do not block the app.
        setStatus("done");
      }
    });
    return () => {
      active = false;
    };
  }, [userId]);

  if (!userId || status === "done") return <>{children}</>;
  if (status === "checking") return null;

  const handleAccept = async () => {
    setSaving(true);
    setError("");
    const consent = await LegalRepository.recordConsents(LEGAL_VERSION, ["eu_storage", "location", "photo"]);
    const result = consent.success ? await LegalRepository.acknowledge(LEGAL_VERSION) : consent;
    setSaving(false);
    if (!result.success) {
      setError(t("legal.gate.error"));
      return;
    }
    writeCache(userId);
    setStatus("done");
  };

  const points = t("legal.gate.points", { returnObjects: true }) as string[];
  const pointTitles = t("legal.gate.pointTitles", { returnObjects: true }) as string[];
  // owner 2026-11-13: the screen shown better - what happens with the data as four small cards, then the three
  // consents as cards to tap, with the buttons always in reach at the bottom
  const icons: LucideIcon[] = [MapPin, Radar, Camera, Eye];
  const consents = [
    { key: "terms", on: checked, set: setChecked, title: t("legal.gate.confirmTermsTitle"), text: profile?.isRealOwner ? t("legal.gate.confirmOwner") : t("legal.gate.confirmMember") },
    { key: "eu", on: euChecked, set: setEuChecked, title: t("legal.gate.confirmEuTitle"), text: t("legal.gate.confirmEuStorage") },
    { key: "capture", on: captureChecked, set: setCaptureChecked, title: t("legal.gate.confirmCaptureTitle"), text: t("legal.gate.confirmCapture") },
  ];
  const done = consents.filter((consent) => consent.on).length;

  return (
    <div className={styles.page}>
      <div className={styles.card} role="dialog" aria-labelledby="legal-gate-title">
        <div className={styles.scroll}>
          <div className={styles.head}>
            <img src="/prosm-logo.png" alt="" className={styles.logo} />
            <h1 id="legal-gate-title" className={styles.title}>
              {t("legal.gate.title")}
            </h1>
            <p className={styles.text}>{t("legal.gate.intro")}</p>
          </div>
          <ul className={styles.points}>
            {points.map((point, index) => {
              const Icon = icons[index] ?? Eye;
              return (
                <li key={point} className={styles.point}>
                  <span className={styles.pointIcon} aria-hidden="true">
                    <Icon size={18} />
                  </span>
                  <span>
                    {pointTitles[index] ? <strong className={styles.pointTitle}>{pointTitles[index]}</strong> : null}
                    <span className={styles.pointText}>{point}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className={styles.full}>
            {t("legal.gate.readFull")} <LegalLinks color="var(--text-link)" />
          </p>
          <div className={styles.consentsHead}>
            <h2 className={styles.consentsTitle}>{t("legal.gate.consentsTitle")}</h2>
            <span className={done === consents.length ? styles.progressDone : styles.progress}>{t("legal.gate.consentsProgress", { done, total: consents.length })}</span>
          </div>
          <div className={styles.consents}>
            {consents.map((consent) => (
              <label key={consent.key} className={consent.on ? `${styles.consent} ${styles.consentOn}` : styles.consent}>
                <input type="checkbox" className={styles.hiddenBox} checked={consent.on} onChange={(event) => consent.set(event.target.checked)} />
                <span className={styles.tick} aria-hidden="true">{consent.on ? <Check size={16} strokeWidth={3} /> : null}</span>
                <span>
                  <strong className={styles.consentTitle}>{consent.title}</strong>
                  <span className={styles.consentText}>{consent.text}</span>
                </span>
              </label>
            ))}
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => signOut()} disabled={saving}>
            {t("legal.gate.signOut")}
          </Button>
          <Button onClick={handleAccept} loading={saving} disabled={!checked || !euChecked || !captureChecked || saving}>
            {t("legal.gate.accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}
