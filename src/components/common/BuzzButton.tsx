import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Vibrate } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import NotificationRepository, { BUZZ_REASONS, type BuzzReason } from "../../core/repositories/NotificationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import ErrorText from "./ErrorText";
import SuccessText from "./SuccessText";
import styles from "./BuzzButton.module.css";

/** Owner 2026-11-10: the owner, managers and supervisors can Buzz someone (the server checks authority). */
export function canBuzz(profile: { isOwner?: boolean; roleKey?: string } | null | undefined): boolean {
  return Boolean(profile && (profile.isOwner || profile.roleKey === "manager" || profile.roleKey === "supervisor"));
}

// Owner 2026-11-10 ("a Buzz button: when I want to alert someone - they did not clock out or in, or
// anything - I press Buzz and their phone vibrates and sounds; for managers, the owner and supervisors"):
// pick what for (clock in, clock out, call me, check the app), add a short message if wanted, send.
export default function BuzzButton({ userId, name, compact = false }: { userId: string; name: string; compact?: boolean }) {
  const { t } = useTranslation(["shell", "common"]);
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<BuzzReason>("clock_in");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");

  if (!canBuzz(profile) || profile?.id === userId) return null;

  const send = async () => {
    setSending(true);
    setError("");
    const result = await NotificationRepository.sendBuzz(userId, reason, message.trim() || null);
    setSending(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("shell:buzz.failed"));
      return;
    }
    setOpen(false);
    setMessage("");
    setSent(t("shell:buzz.sent", { name }));
  };

  return (
    <>
      <button type="button" className={compact ? `${styles.trigger} ${styles.compact}` : styles.trigger}
        onClick={(event) => { event.stopPropagation(); setSent(""); setError(""); setOpen(true); }}
        aria-label={t("shell:buzz.title", { name })} title={t("shell:buzz.title", { name })}>
        <Vibrate size={compact ? 15 : 16} aria-hidden="true" />
        {compact ? null : <span>{t("shell:buzz.action")}</span>}
      </button>
      {sent ? <SuccessText>{sent}</SuccessText> : null}
      <Modal isOpen={open} onClose={() => setOpen(false)} title={t("shell:buzz.title", { name })} size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={sending}>{t("common:actions.cancel")}</Button>
            <Button onClick={send} loading={sending}><Vibrate size={16} aria-hidden="true" /> {t("shell:buzz.send")}</Button>
          </>
        )}>
        <p className={styles.hint}>{t("shell:buzz.hint")}</p>
        <div className={styles.reasons} role="radiogroup" aria-label={t("shell:buzz.title", { name })}>
          {BUZZ_REASONS.map((key) => (
            <button key={key} type="button" role="radio" aria-checked={reason === key}
              className={reason === key ? `${styles.reason} ${styles.reasonActive}` : styles.reason} onClick={() => setReason(key)}>
              {t(`shell:buzz.reasons.${key}`)}
            </button>
          ))}
        </div>
        <Input label={t("shell:buzz.messageLabel")} name="buzzMessage" value={message}
          onChange={(event) => setMessage(event.target.value.slice(0, 140))} disabled={sending} />
        <ErrorText>{error}</ErrorText>
      </Modal>
    </>
  );
}
