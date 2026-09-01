import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import styles from "./Modal.module.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

// PROSM Time - mirrors PROSM Platform's own Modal size variants
// exactly (sm/md/lg -> 420/640/960px max-width), added for the
// CameraCaptureModal port (needs "md" to show a real camera viewport,
// not the previous single fixed 440px width every modal was forced
// into) - § final visual consistency pass.
export default function Modal({ isOpen, onClose, title, children, footer, size = "sm" }: ModalProps) {
  const { t } = useTranslation("common");
  if (!isOpen) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={[styles.panel, styles[size]].filter(Boolean).join(" ")}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("actions.close")} className={styles.closeButton}>
            &times;
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}
