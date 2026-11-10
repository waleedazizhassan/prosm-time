import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";

import type { ErrorFix } from "../../core/utils/errorFix";
import styles from "./ClockNotice.module.css";

export interface ClockNoticeMessage {
  tone: "success" | "warning" | "error";
  title: string;
  text?: string;
  fix?: ErrorFix | null;
}

// Owner 2026-11-10: the attendance messages look different from the rest - a card that slides down at
// the top of the map, coloured by what happened (clocked in, break, site changed, or a problem), with the
// step that fixes a problem. A success closes by itself after a few seconds.
export default function ClockNotice({ notice, onClose }: { notice: ClockNoticeMessage | null; onClose: () => void }) {
  const { t } = useTranslation("common");

  useEffect(() => {
    if (!notice || notice.tone !== "success") return undefined;
    const timer = window.setTimeout(onClose, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, onClose]);

  if (!notice) return null;
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "warning" ? AlertTriangle : XCircle;
  return (
    <div className={`${styles.notice} ${styles[notice.tone]}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span className={styles.icon} aria-hidden="true"><Icon size={26} /></span>
      <div className={styles.body}>
        <strong className={styles.title}>{notice.title}</strong>
        {notice.text ? <p className={styles.text}>{notice.text}</p> : null}
        {notice.fix ? (
          <button type="button" className={styles.fix} onClick={() => { onClose(); notice.fix?.run(); }}>
            {notice.fix.label}
          </button>
        ) : null}
      </div>
      <button type="button" className={styles.close} onClick={onClose} aria-label={t("feedback.close")}>
        <X size={16} />
      </button>
    </div>
  );
}
