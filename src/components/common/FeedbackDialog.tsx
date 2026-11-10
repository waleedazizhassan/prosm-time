import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { FeedbackMessage } from "../../core/context/FeedbackContext";
import { STATE_ART } from "./stateArt";
import styles from "./FeedbackDialog.module.css";

// Owner 2026-11-10: one box in the middle of the screen for every error and success message - a
// picture of what happened, a short title, the explanation, and OK (or the action the message offers).
export default function FeedbackDialog({ message, onClose }: { message: FeedbackMessage; onClose: () => void }) {
  const { t } = useTranslation("common");
  const okRef = useRef<HTMLButtonElement>(null);
  const kind = message.kind ?? (message.tone === "success" ? "success" : "error");

  useEffect(() => {
    okRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [message, onClose]);

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={`${styles.box} ${message.tone === "success" ? styles.success : styles.error}`}
        role={message.tone === "error" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="feedback-title"
        aria-describedby="feedback-text"
        onClick={(event) => event.stopPropagation()}
      >
        <img src={STATE_ART[kind]} alt="" className={styles.art} />
        <h2 id="feedback-title" className={styles.title}>
          {message.title ?? (message.tone === "success" ? t("feedback.successTitle") : t("feedback.errorTitle"))}
        </h2>
        <p id="feedback-text" className={styles.text}>{message.text}</p>
        <div className={styles.actions}>
          {message.action ? (
            <button type="button" className={styles.secondary} onClick={() => { message.action?.onClick(); onClose(); }}>
              {message.action.label}
            </button>
          ) : null}
          <button ref={okRef} type="button" className={styles.ok} onClick={onClose}>
            {t("feedback.ok")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
