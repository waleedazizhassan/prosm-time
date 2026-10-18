import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
    const result = await LegalRepository.acknowledge(LEGAL_VERSION);
    setSaving(false);
    if (!result.success) {
      setError(t("legal.gate.error"));
      return;
    }
    writeCache(userId);
    setStatus("done");
  };

  const points = t("legal.gate.points", { returnObjects: true }) as string[];

  return (
    <div className={styles.page}>
      <div className={styles.card} role="dialog" aria-labelledby="legal-gate-title">
        <h1 id="legal-gate-title" className={styles.title}>
          {t("legal.gate.title")}
        </h1>
        <p className={styles.text}>{t("legal.gate.intro")}</p>
        <ul className={styles.points}>
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <p className={styles.text}>
          {t("legal.gate.readFull")} <LegalLinks color="var(--text-link)" />
        </p>
        <label className={styles.confirm}>
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>{profile?.isOwner ? t("legal.gate.confirmOwner") : t("legal.gate.confirmMember")}</span>
        </label>
        <ErrorText>{error}</ErrorText>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => signOut()} disabled={saving}>
            {t("legal.gate.signOut")}
          </Button>
          <Button onClick={handleAccept} loading={saving} disabled={!checked || saving}>
            {t("legal.gate.accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}
